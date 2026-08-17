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
