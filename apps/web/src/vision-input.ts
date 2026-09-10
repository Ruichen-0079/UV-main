export type VisionImageMimeType = "image/png" | "image/jpeg";

export function normalizeVisionImageMimeType(
  value: string | undefined
): VisionImageMimeType | undefined {
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType === "image/png") return "image/png";
  if (mediaType === "image/jpeg" || mediaType === "image/jpg") return "image/jpeg";
  return undefined;
}

export function extractVisionRawBase64(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

export function toVisionFileInput(
  dataUrl: string,
  fileType: string
): { imageBase64: string; mimeType: VisionImageMimeType } {
  const mimeType = normalizeVisionImageMimeType(fileType);
  if (!mimeType) {
    throw new Error("Only PNG and JPEG image files are supported.");
  }
  return { imageBase64: extractVisionRawBase64(dataUrl), mimeType };
}


export const VISION_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

export type VisionImageAttachmentDraft = Readonly<{
  name: string;
  size: number;
  dataUrl: string;
  imageBase64: string;
  mimeType: VisionImageMimeType;
}>;

export async function readVisionImageAttachment(file: File): Promise<VisionImageAttachmentDraft> {
  const mimeType = normalizeVisionImageMimeType(file.type);
  if (!mimeType) {
    throw new Error("Only PNG and JPEG image files are supported.");
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    throw new Error("The selected image is empty.");
  }
  if (file.size > VISION_IMAGE_MAX_BYTES) {
    throw new Error("The selected image exceeds the 20 MiB limit.");
  }

  const dataUrl = await readFileAsDataUrl(file);
  const payload = toVisionFileInput(dataUrl, mimeType);
  if (!payload.imageBase64) {
    throw new Error("The selected image is empty.");
  }
  return Object.freeze({
    name: file.name || "image",
    size: file.size,
    dataUrl,
    ...payload
  });
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The selected image could not be read."));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("The selected image could not be read."));
        return;
      }
      resolve(reader.result);
    };
    reader.readAsDataURL(file);
  });
}
