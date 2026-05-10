import { db, newId, type Person, type TranscriptSegment } from "./db";

const SELF_INTRO_REGEXES = [
  /\bi['’]?m\s+([A-Z][a-zA-Z'-]+)\b/,
  /\bi am\s+([A-Z][a-zA-Z'-]+)\b/i,
  /\bit['’]?s\s+([A-Z][a-zA-Z'-]+)\b/,
  /\bthis is\s+([A-Z][a-zA-Z'-]+)\b/i,
  /\b([A-Z][a-zA-Z'-]+)\s+here\b/,
  /\bmy name is\s+([A-Z][a-zA-Z'-]+)\b/i,
  /\bcall me\s+([A-Z][a-zA-Z'-]+)\b/i,
];

const STOP_NAMES = new Set([
  "James",
  "Mr",
  "Mrs",
  "Ms",
  "Dr",
  "Hello",
  "Hi",
  "Hey",
  "Yes",
  "No",
  "OK",
  "Okay",
  "Sorry",
  "Thanks",
  "Speaker",
]);

/** Names introduced via self-intro patterns in the transcript. */
export function extractIntroducedNames(
  segments: { text: string; speaker_label: string }[],
): { name: string; speaker_label: string }[] {
  const out: { name: string; speaker_label: string }[] = [];
  const seen = new Set<string>();
  for (const seg of segments) {
    for (const rx of SELF_INTRO_REGEXES) {
      const m = seg.text.match(rx);
      if (m?.[1]) {
        const name = m[1];
        if (STOP_NAMES.has(name)) continue;
        const key = name.toLowerCase() + "|" + seg.speaker_label;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ name, speaker_label: seg.speaker_label });
        break;
      }
    }
  }
  return out;
}

/**
 * Auto-create Person rows for any introduced names not already in the DB.
 * Returns the full list of new people created.
 */
export async function autoCreateIntroducedPeople(
  segments: TranscriptSegment[],
  existing: Person[],
  opts?: { placeId?: string },
): Promise<Person[]> {
  const introduced = extractIntroducedNames(segments);
  if (introduced.length === 0) return [];
  const haveByFirst = new Set(
    existing.map((p) => p.name.trim().split(/\s+/)[0].toLowerCase()),
  );
  const created: Person[] = [];
  for (const { name } of introduced) {
    const key = name.toLowerCase();
    if (haveByFirst.has(key)) continue;
    haveByFirst.add(key);
    const p: Person = {
      id: newId(),
      name,
      relationship: "",
      interests: [],
      notes: opts?.placeId
        ? `Auto-added — first met during a conversation.`
        : "Auto-added from conversation.",
      style_notes: "",
      created_at: Date.now(),
    };
    await db.people.put(p);
    created.push(p);
  }
  return created;
}