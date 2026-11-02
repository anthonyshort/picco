import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { type BrowserArtifact, type BrowserEvidence } from "./types.js";

const execute = promisify(execFile);
const MAX_BYTES = 25 * 1024 * 1024;

/**
 * Retrieve bounded evidence only from the configured Atlas origin, without redirects or cookies.
 */
export async function collectEvidence(
  evidence: BrowserEvidence,
  opts: { url: string; token: string; fetch?: typeof fetch },
  directory: string,
  signal: AbortSignal,
  onArtifact?: (artifacts: BrowserArtifact[]) => void,
): Promise<{ artifacts: BrowserArtifact[]; limits: string[] }> {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const artifacts: BrowserArtifact[] = [];
  const limits: string[] = [];
  for (const [index, reference] of evidence.artifacts.entries()) {
    signal.throwIfAborted();
    let artifact: BrowserArtifact | undefined;
    try {
      const url = new URL(reference.url);
      if (url.origin !== new URL(opts.url).origin || url.username || url.password)
        throw new Error("Evidence reference is outside the configured Atlas origin");
      const response = await (opts.fetch ?? fetch)(url, {
        headers: { authorization: `Bearer ${opts.token}` },
        redirect: "error",
        signal,
      });
      if (!response.ok || !response.body)
        throw new Error("Evidence download was not authorised or available");
      if (Number(response.headers.get("content-length")) > MAX_BYTES)
        throw new Error("Evidence exceeds 25 MB");
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > MAX_BYTES) throw new Error("Evidence exceeds 25 MB");
        chunks.push(chunk);
      }
      const data = Buffer.concat(chunks);
      let mimeType: string;
      let extension: string;
      if (reference.kind === "screenshot") {
        if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
          mimeType = "image/png";
          extension = "png";
        } else if (data[0] === 255 && data[1] === 216 && data[2] === 255) {
          mimeType = "image/jpeg";
          extension = "jpg";
        } else if (
          data.toString("ascii", 0, 4) === "RIFF" &&
          data.toString("ascii", 8, 12) === "WEBP"
        ) {
          mimeType = "image/webp";
          extension = "webp";
        } else throw new Error("Screenshot is not a supported image");
      } else {
        if (data.toString("ascii", 4, 8) !== "ftyp")
          throw new Error("Recording is not an MP4 file");
        mimeType = "video/mp4";
        extension = "mp4";
      }
      const file = path.join(directory, `${index}.${extension}`);
      writeFileSync(file, data, { mode: 0o600 });
      if (reference.kind === "video") {
        const probe = await execute(
          "ffprobe",
          [
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=codec_type",
            "-of",
            "json",
            file,
          ],
          { signal, timeout: 10000 },
        );
        const metadata = z
          .object({
            streams: z.array(z.object({ codec_type: z.string() })).max(20),
            format: z.object({ duration: z.string() }),
          })
          .parse(JSON.parse(probe.stdout));
        const duration = Number(metadata.format.duration);
        if (
          !metadata.streams.some((stream) => stream.codec_type === "video") ||
          !Number.isFinite(duration) ||
          duration <= 0 ||
          duration > 60
        )
          throw new Error("Recording has no playable short video stream");
        mkdirSync(`${file}.frames`, { mode: 0o700, recursive: true });
        await execute(
          "ffmpeg",
          [
            "-v",
            "error",
            "-i",
            file,
            "-vf",
            "fps=1/5,scale=640:-2",
            "-frames:v",
            "6",
            "-y",
            path.join(`${file}.frames`, "%02d.jpg"),
          ],
          { signal, timeout: 10000 },
        );
      }
      artifact = { kind: reference.kind, source: reference.url, file, bytes, mimeType };
    } catch {
      signal.throwIfAborted();
      // External errors can contain signed URLs or credentials; return a fixed diagnostic.
      limits.push(
        `${reference.kind} ${index + 1} could not be retrieved and verified through the configured Atlas access.`,
      );
    }
    if (artifact) {
      artifacts.push(artifact);
      onArtifact?.(artifacts.slice());
    }
  }
  return { artifacts, limits };
}
