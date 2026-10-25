import type { BigIntStats } from "node:fs";

export interface ManifestFile {
  path: string;
  base64: string;
}
export interface CheckpointFile {
  path: string;
  sha256: string;
}
export interface Checkpoint {
  version: 1 | 2;
  trackedSource?: "broker-full-manifest";
  selector: string;
  repoId: string;
  files: CheckpointFile[];
}
export interface ManifestData {
  repoId: string;
  filesAreFullManifest?: boolean;
}
export interface PathSnapshot {
  absolute: string;
  canonical: string;
  records: { path: string; identity: string; stat: BigIntStats }[];
  stat: BigIntStats;
}
export function safeManifestPath(value: unknown): boolean;
export function inspectSelectedPath(source: string): Promise<PathSnapshot>;
export function verifySelectedPath(
  snapshot: PathSnapshot,
): Promise<PathSnapshot>;
export function readSelectedFile(
  source: string,
  options?: {
    maxBytes?: number;
    audit?: (
      phase: "inspected" | "before-read" | "after-read",
    ) => void | Promise<void>;
  },
): Promise<Buffer>;
export function readSelectedDirectory(
  snapshot: PathSnapshot,
): Promise<string[]>;
export function collectSelectedFiles(
  source: string,
  recursive: boolean,
  patterns?: string[],
): Promise<{
  files: ManifestFile[];
  label: string;
  directory: boolean;
}>;
export function digest(bytes: Buffer | string): string;
export function gitFileSafe(file: { path: string }): boolean;
export function trackedCheckpoint(
  files: unknown,
  selector: string,
  data: ManifestData,
): Checkpoint;
export function validateCheckpoint(
  record: unknown,
  selector: string,
  repoId: string,
): Checkpoint;
export function checkpointDeletions(
  previous: Checkpoint,
  next: Checkpoint,
): CheckpointFile[];
export function gitCommitDeletions(
  previous: Checkpoint,
  files: ManifestFile[],
): CheckpointFile[];
export function collectGitCommitFiles(
  directory: string,
  selector: string,
  repoId: string,
): Promise<{
  files: ManifestFile[];
  deletions: CheckpointFile[];
  checkpointHash: string;
}>;
export function commitCheckpoint(
  previous: Checkpoint,
  files: unknown,
  selector: string,
  data: ManifestData,
  repoId: string,
): Checkpoint | undefined;
export function validateManifestPaths<T extends { path: string }>(
  files: T[],
  git?: boolean,
): T[];
export function checkpointMarker(directory: string): Promise<string>;
export function inspectOutputDestination(target: string): Promise<void>;
export function applyTrackedWorktree(
  files: ManifestFile[],
  destination: string,
  command: "clone" | "pull",
  selector: string,
  data: ManifestData,
  options?: {
    audit?: (
      phase: "staged" | "old-staged" | "written" | "before-marker",
      index?: number,
    ) => void | Promise<void>;
  },
): Promise<Checkpoint>;
