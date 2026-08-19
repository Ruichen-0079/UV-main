#![allow(non_snake_case)]

use std::env;
use std::ffi::c_void;

type Handle = *mut c_void;
type Dword = u32;
type Bool = i32;

const PROCESS_QUERY_LIMITED_INFORMATION: Dword = 0x1000;
const WINDOWS_TO_UNIX_EPOCH_SECONDS: u64 = 11_644_473_600;

#[repr(C)]
#[derive(Clone, Copy)]
struct FileTime {
    dwLowDateTime: Dword,
    dwHighDateTime: Dword,
}

#[link(name = "kernel32")]
extern "system" {
    fn OpenProcess(desired_access: Dword, inherit_handle: Bool, process_id: Dword) -> Handle;
    fn QueryFullProcessImageNameW(
        process: Handle,
        flags: Dword,
        exe_name: *mut u16,
        size: *mut Dword,
    ) -> Bool;
    fn GetProcessTimes(
        process: Handle,
        creation: *mut FileTime,
        exit: *mut FileTime,
        kernel: *mut FileTime,
        user: *mut FileTime,
    ) -> Bool;
    fn CloseHandle(object: Handle) -> Bool;
}

struct ProcessHandle(Handle);

impl Drop for ProcessHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

fn fail() -> ! {
    std::process::exit(1)
}

fn parse_pid() -> Dword {
    let mut args = env::args_os();
    let _program = args.next();
    let Some(raw) = args.next() else { fail() };
    if args.next().is_some() {
        fail();
    }
    let raw = raw.to_string_lossy();
    if raw.is_empty() || raw.len() > 10 || !raw.bytes().all(|byte| byte.is_ascii_digit()) {
        fail();
    }
    let Ok(pid) = raw.parse::<u64>() else { fail() };
    if pid == 0 || pid > Dword::MAX as u64 {
        fail();
    }
    pid as Dword
}

fn file_time_ticks(value: FileTime) -> u64 {
    ((value.dwHighDateTime as u64) << 32) | value.dwLowDateTime as u64
}

fn civil_from_days(days_since_unix_epoch: i64) -> (i64, u32, u32) {
    let shifted = days_since_unix_epoch + 719_468;
    let era = if shifted >= 0 {
        shifted / 146_097
    } else {
        (shifted - 146_096) / 146_097
    };
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_part = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_part + 2) / 5 + 1;
    let month = month_part + if month_part < 10 { 3 } else { -9 };
    let year = year + if month <= 2 { 1 } else { 0 };
    (year, month as u32, day as u32)
}

fn format_utc_from_file_time(value: FileTime) -> Option<String> {
    let ticks = file_time_ticks(value);
    let total_milliseconds = ticks / 10_000;
    let unix_milliseconds =
        total_milliseconds.checked_sub(WINDOWS_TO_UNIX_EPOCH_SECONDS * 1_000)?;
    let days = (unix_milliseconds / 86_400_000) as i64;
    let day_milliseconds = unix_milliseconds % 86_400_000;
    let hour = day_milliseconds / 3_600_000;
    let minute = (day_milliseconds % 3_600_000) / 60_000;
    let second = (day_milliseconds % 60_000) / 1_000;
    let millisecond = day_milliseconds % 1_000;
    let (year, month, day) = civil_from_days(days);
    Some(format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millisecond:03}Z"
    ))
}

fn json_escape(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '\\' => escaped.push_str("\\\\"),
            '"' => escaped.push_str("\\\""),
            '\u{08}' => escaped.push_str("\\b"),
            '\u{0c}' => escaped.push_str("\\f"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            character if character <= '\u{1f}' => {
                escaped.push_str(&format!("\\u{:04x}", character as u32))
            }
            _ => escaped.push(character),
        }
    }
    escaped
}

fn main() {
    let process_id = parse_pid();
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) };
    if handle.is_null() {
        fail();
    }
    let handle = ProcessHandle(handle);

    let mut path_buffer = [0u16; 4_096];
    let mut path_length = path_buffer.len() as Dword;
    let path_ok = unsafe {
        QueryFullProcessImageNameW(handle.0, 0, path_buffer.as_mut_ptr(), &mut path_length)
    } != 0;
    if !path_ok || path_length == 0 || path_length as usize > path_buffer.len() {
        fail();
    }
    let executable_path = String::from_utf16(&path_buffer[..path_length as usize]).ok();
    let Some(executable_path) = executable_path else {
        fail()
    };
    let path_bytes = executable_path.as_bytes();
    let drive_absolute = path_bytes.len() >= 3
        && path_bytes[0].is_ascii_alphabetic()
        && path_bytes[1] == b':'
        && (path_bytes[2] == b'\\' || path_bytes[2] == b'/');
    if !drive_absolute && !executable_path.starts_with("\\\\") {
        fail();
    }

    let mut creation = FileTime {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut exit = creation;
    let mut kernel = creation;
    let mut user = creation;
    let times_ok =
        unsafe { GetProcessTimes(handle.0, &mut creation, &mut exit, &mut kernel, &mut user) } != 0;
    if !times_ok {
        fail();
    }
    let Some(started_at_utc) = format_utc_from_file_time(creation) else {
        fail()
    };

    println!(
        "{{\"protocol\":1,\"status\":\"RESOLVED\",\"processId\":{process_id},\"executablePath\":\"{}\",\"startedAtUtc\":\"{started_at_utc}\"}}",
        json_escape(&executable_path)
    );
}
