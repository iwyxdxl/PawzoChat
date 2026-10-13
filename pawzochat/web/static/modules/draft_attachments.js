/*! PawzoChat — draft attachment snapshots, AGPL-3.0-or-later. */

// A File may still expose its name/size after the disk file becomes unreadable.
// Read every byte before upload and use a memory-backed copy to close the gap
// between validation and FormData submission. Preview URLs alone prove nothing.
export async function snapshotDraftFile(file) {
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength !== file.size) throw new Error('Incomplete attachment');
  return new File([bytes], file.name, { type: file.type, lastModified: file.lastModified });
}

export async function prepareDraftAttachments(items) {
  const ready = [], unavailable = [];
  for (const item of items) {
    try { ready.push({ item, file: await snapshotDraftFile(item.file) }); }
    catch { unavailable.push(item); }
  }
  return { ready, unavailable };
}
