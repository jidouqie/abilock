// Frozen public Abilock 2.0.0 compatibility fixture; do not modernize this schema.
// Origin: abilock-2.0.0.tgz, package/src/capability-notes.ts.
// Original member SHA-256: 2f63c826e4e1f29afb34e082de35d724bee557fc0aae602acfd6be0839162dad
// Exact excerpt: capabilityNoteSchema and capabilityNotesSchema, with their original import and type.
// Unused runtime schemas/types were omitted. No credentials, state, generated
// runtime, package installation, or private acceptance artifacts are included.
import { z } from "zod";

// Descriptive metadata only; an HTTP note must bind to an already allowed rule.
export const capabilityNoteSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    summary: z.string().trim().min(1).max(2000),
    tags: z.array(z.string().trim().min(1).max(80)).max(12).default([]),
    input: z.string().max(2000).default(""),
    output: z.string().max(2000).default(""),
    method: z
      .enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"])
      .optional(),
    path: z.string().min(1).max(500).optional(),
  })
  .strict();
export const capabilityNotesSchema = z
  .array(capabilityNoteSchema)
  .max(1000)
  .refine((notes) => {
    const keys = notes.map((note) =>
      JSON.stringify([note.method, note.path, note.name.toLowerCase()]),
    );
    return new Set(keys).size === keys.length;
  }, "同一接口的能力说明名称不能重复");
export type CapabilityNote = z.infer<typeof capabilityNoteSchema>;

