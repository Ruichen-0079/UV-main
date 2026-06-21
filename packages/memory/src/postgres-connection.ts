export function normalizePostgresConnectionString(
  connectionString: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform !== "win32") {
    return connectionString;
  }

  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return connectionString;
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    return connectionString;
  }

  if (url.hostname !== "localhost") {
    return connectionString;
  }

  url.hostname = "127.0.0.1";
  return url.toString();
}
