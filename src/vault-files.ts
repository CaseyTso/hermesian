import {
  existsSync,
  promises as fs,
  realpathSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

interface ReadTextRequest {
  limit?: number | null;
  line?: number | null;
  path: string;
}

interface WriteTextRequest {
  content: string;
  path: string;
}

function isInside(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) &&
      pathFromRoot !== ".." &&
      !isAbsolute(pathFromRoot))
  );
}

function canonicalizePotentialPath(target: string): string {
  let existingAncestor = target;
  const missingSegments: string[] = [];

  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) {
      break;
    }
    missingSegments.unshift(basename(existingAncestor));
    existingAncestor = parent;
  }

  const canonicalAncestor = realpathSync(existingAncestor);
  return resolve(canonicalAncestor, ...missingSegments);
}

export function resolveVaultPath(vaultRoot: string, requestedPath: string): string {
  const lexicalRoot = resolve(vaultRoot);
  const canonicalRoot = realpathSync(lexicalRoot);
  const lexicalTarget = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(lexicalRoot, requestedPath);

  if (!isInside(lexicalRoot, lexicalTarget)) {
    throw new Error(`Path is outside the Obsidian vault: ${requestedPath}`);
  }

  const canonicalTarget = canonicalizePotentialPath(lexicalTarget);
  if (!isInside(canonicalRoot, canonicalTarget)) {
    throw new Error(`Path is outside the Obsidian vault: ${requestedPath}`);
  }

  return canonicalTarget;
}

export async function readVaultTextFile(
  vaultRoot: string,
  request: ReadTextRequest,
): Promise<{ content: string }> {
  const target = resolveVaultPath(vaultRoot, request.path);
  const content = await fs.readFile(target, "utf8");
  if (request.line == null && request.limit == null) {
    return { content };
  }

  const lines = content.split("\n");
  const start = Math.max(0, Math.trunc(request.line ?? 1) - 1);
  const limit =
    request.limit == null
      ? lines.length - start
      : Math.max(0, Math.trunc(request.limit));
  return { content: lines.slice(start, start + limit).join("\n") };
}

export async function writeVaultTextFile(
  vaultRoot: string,
  request: WriteTextRequest,
): Promise<void> {
  const target = resolveVaultPath(vaultRoot, request.path);
  await fs.mkdir(dirname(target), { recursive: true });
  await fs.writeFile(target, request.content, "utf8");
}

export function vaultRelativePath(vaultRoot: string, targetPath: string): string {
  const target = resolveVaultPath(vaultRoot, targetPath);
  return relative(realpathSync(vaultRoot), target) || join(".");
}
