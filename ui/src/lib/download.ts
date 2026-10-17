export function downloadTextFile(filename: string, content: string, type = "text/plain"): void {
  downloadBlobFile(filename, new Blob([content], { type }));
}

export function downloadBlobFile(filename: string, content: Blob): void {
  const url = URL.createObjectURL(content);
  downloadHref(url, filename);
  // Let the browser consume the click before releasing the download payload.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadHref(href: string, filename: string): void {
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  link.click();
}
