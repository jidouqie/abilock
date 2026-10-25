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

export const serverInventorySchema = z
  .object({
    inspectedAt: z.string().datetime(),
    os: z.enum([
      "Linux",
      "Darwin",
      "FreeBSD",
      "OpenBSD",
      "NetBSD",
      "SunOS",
      "unknown",
    ]),
    architecture: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
    tools: z
      .array(
        z.enum([
          "node",
          "python3",
          "ffmpeg",
          "docker",
          "nginx",
          "git",
          "psql",
          "mysql",
          "redis-cli",
        ]),
      )
      .max(9),
  })
  .strict();
export type ServerInventory = z.infer<typeof serverInventorySchema>;
