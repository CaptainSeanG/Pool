const LEDGER_PATH = "ledger.json";

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env, request);
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const url = new URL(request.url);
    try {
      if (url.pathname === "/health") {
        return json({ ok: true }, cors);
      }
      if (url.pathname === "/upload" && request.method === "POST") {
        return await handleUpload(request, env, cors);
      }
      if (url.pathname === "/row" && request.method === "POST") {
        return await handleRowUpdate(request, env, cors);
      }
      if (url.pathname === "/delete" && request.method === "POST") {
        return await handleDelete(request, env, cors);
      }
      return json({ error: "Not found" }, cors, 404);
    } catch (error) {
      return json({ error: error.message || "Upload failed" }, cors, 500);
    }
  },
};

async function handleUpload(request, env, cors) {
  const authError = validateUploadKey(request, env, cors);
  if (authError) return authError;

  const body = await request.json();
  const row = sanitizeRow(body.row || {});
  const photo = body.photo || row.photo || {};
  const dataUrl = photo.dataUrl || "";
  const match = dataUrl.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i);
  if (!match) return json({ error: "Missing image data" }, cors, 400);

  const ext = match[1].toLowerCase() === "jpeg" ? "jpg" : match[1].toLowerCase();
  const id = safeName(row.id || `upload-${Date.now()}`);
  const date = safeName(row.date || new Date().toISOString().slice(0, 10));
  const imagePath = `uploads/${date}/${id}.${ext}`;

  await putGithubFile(env, imagePath, match[2], `Add pool test image ${id}`);
  const processed = parseImageDataUrl(photo.processedDataUrl || "");
  const processedPath = processed ? `uploads/${date}/${id}-strip.${processed.ext}` : "";
  if (processed) {
    await putGithubFile(env, processedPath, processed.base64, `Add pool test strip crop ${id}`);
  }

  const existing = await getGithubJson(env, LEDGER_PATH, []);
  const ledger = Array.isArray(existing.content) ? existing.content : [];
  const publicRow = {
    ...row,
    photo: {
      path: imagePath,
      url: imagePath,
      name: photo.name || `${id}.${ext}`,
      type: `image/${ext === "jpg" ? "jpeg" : ext}`,
      width: photo.width || null,
      height: photo.height || null,
      uploadedAt: photo.uploadedAt || new Date().toISOString(),
      processedPath: processedPath || null,
      processedUrl: processedPath || null,
    },
  };
  const nextLedger = [publicRow, ...ledger.filter((item) => item.id !== publicRow.id)];
  await putGithubFile(
    env,
    LEDGER_PATH,
    toBase64(JSON.stringify(nextLedger, null, 2) + "\n"),
    `Update pool ledger ${id}`,
    existing.sha
  );

  return json({ ok: true, row: publicRow }, cors);
}

function parseImageDataUrl(dataUrl) {
  const match = String(dataUrl || "").match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i);
  if (!match) return null;
  const ext = match[1].toLowerCase() === "jpeg" ? "jpg" : match[1].toLowerCase();
  return { ext, base64: match[2] };
}

async function handleRowUpdate(request, env, cors) {
  const authError = validateUploadKey(request, env, cors);
  if (authError) return authError;

  const body = await request.json();
  const row = sanitizeRow(body.row || {});
  if (!row.id) return json({ error: "Missing row id" }, cors, 400);

  let savedRow = row;
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await getGithubJson(env, LEDGER_PATH, []);
    const ledger = Array.isArray(existing.content) ? existing.content : [];
    const previous = ledger.find((item) => String(item.id) === String(row.id));
    savedRow = {
      ...(previous || {}),
      ...row,
      photo: row.photo || previous?.photo || null,
    };
    const nextLedger = [savedRow, ...ledger.filter((item) => String(item.id) !== String(row.id))];

    try {
      await putGithubFile(
        env,
        LEDGER_PATH,
        toBase64(JSON.stringify(nextLedger, null, 2) + "\n"),
        `Update pool ledger row ${safeName(row.id)}`,
        existing.sha
      );
      return json({ ok: true, row: savedRow }, cors);
    } catch (error) {
      if (!isGithubConflict(error) || attempt === 2) throw error;
      await sleep(250 * (attempt + 1));
    }
  }

  return json({ ok: false, error: "Row update failed" }, cors, 500);
}

async function handleDelete(request, env, cors) {
  const authError = validateUploadKey(request, env, cors);
  if (authError) return authError;

  const body = await request.json();
  const id = String(body.id || "").trim();
  if (!id) return json({ error: "Missing row id" }, cors, 400);

  let row = null;
  let deleted = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await getGithubJson(env, LEDGER_PATH, []);
    const ledger = Array.isArray(existing.content) ? existing.content : [];
    row = ledger.find((item) => String(item.id) === id) || row;
    const nextLedger = ledger.filter((item) => String(item.id) !== id);

    if (nextLedger.length === ledger.length) {
      return json({ ok: true, deleted: false }, cors);
    }

    try {
      await putGithubFile(
        env,
        LEDGER_PATH,
        toBase64(JSON.stringify(nextLedger, null, 2) + "\n"),
        `Delete pool ledger row ${safeName(id)}`,
        existing.sha
      );
      deleted = true;
      break;
    } catch (error) {
      if (!isGithubConflict(error) || attempt === 2) throw error;
      await sleep(250 * (attempt + 1));
    }
  }

  if (!deleted) return json({ ok: true, deleted: false }, cors);

  const imagePath = getUploadImagePath(row);
  let imageDeleted = false;
  if (imagePath) {
    try {
      const meta = await getGithubFileMeta(env, imagePath);
      if (meta?.sha) {
        await deleteGithubFile(env, imagePath, meta.sha, `Delete pool test image ${safeName(id)}`);
        imageDeleted = true;
      }
    } catch (error) {
      console.warn(`Image cleanup failed for ${imagePath}:`, error);
    }
  }

  return json({ ok: true, deleted: true, imageDeleted }, cors);
}

function validateUploadKey(request, env, cors) {
  const uploadKey = request.headers.get("x-pool-upload-key") || "";
  if (!env.UPLOAD_KEY || uploadKey !== env.UPLOAD_KEY) {
    return json({ error: "Invalid upload key" }, cors, 401);
  }
  return null;
}

function sanitizeRow(row) {
  const clean = {};
  const fields = [
    "id", "date", "time", "source", "confidence", "fc", "tc", "ph", "ta", "ch",
    "cya", "iron", "copper", "phosphates", "tds", "notes", "analysis"
  ];
  for (const field of fields) clean[field] = row[field] ?? null;
  clean.id = String(clean.id || `upload-${Date.now()}`);
  clean.date = String(clean.date || new Date().toISOString().slice(0, 10));
  clean.time = clean.time ? String(clean.time) : "";
  clean.source = clean.source ? String(clean.source) : "Phone upload";
  clean.confidence = clean.confidence ? String(clean.confidence) : "Review";
  clean.notes = clean.notes ? String(clean.notes) : "";
  clean.analysis = clean.analysis ? String(clean.analysis) : "";
  for (const field of ["fc", "tc", "ph", "ta", "ch", "cya", "iron", "copper", "phosphates", "tds"]) {
    clean[field] = clean[field] === null || clean[field] === "" ? null : Number(clean[field]);
    if (!Number.isFinite(clean[field])) clean[field] = null;
  }
  return clean;
}

function safeName(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "upload";
}

async function getGithubJson(env, path, fallback) {
  const response = await githubFetch(env, `contents/${path}?ref=${encodeURIComponent(env.GITHUB_BRANCH)}`);
  if (response.status === 404) return { content: fallback, sha: null };
  if (!response.ok) throw new Error(`GitHub read failed: ${response.status}`);
  const payload = await response.json();
  const text = fromBase64(payload.content.replace(/\n/g, ""));
  return { content: JSON.parse(text), sha: payload.sha };
}

async function getGithubFileMeta(env, path) {
  const response = await githubFetch(env, `contents/${path}?ref=${encodeURIComponent(env.GITHUB_BRANCH)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub file lookup failed: ${response.status}`);
  return response.json();
}

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function putGithubFile(env, path, base64Content, message, sha = null) {
  const body = {
    message,
    content: base64Content,
    branch: env.GITHUB_BRANCH,
  };
  if (sha) body.sha = sha;
  const response = await githubFetch(env, `contents/${path}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub write failed: ${response.status} ${text}`);
  }
  return response.json();
}

function isGithubConflict(error) {
  return String(error?.message || "").includes("GitHub write failed: 409");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deleteGithubFile(env, path, sha, message) {
  const response = await githubFetch(env, `contents/${path}`, {
    method: "DELETE",
    body: JSON.stringify({
      message,
      sha,
      branch: env.GITHUB_BRANCH,
    }),
  });
  if (!response.ok && response.status !== 404) {
    const text = await response.text();
    throw new Error(`GitHub delete failed: ${response.status} ${text}`);
  }
  return response.status === 404 ? null : response.json();
}

function getUploadImagePath(row) {
  const path = row?.photo?.path || row?.photo?.url || "";
  const cleanPath = String(path).replace(/^\/+/, "");
  return cleanPath.startsWith("uploads/") ? cleanPath : "";
}

function githubFetch(env, path, init = {}) {
  if (!env.GITHUB_TOKEN) throw new Error("Missing GITHUB_TOKEN secret");
  return fetch(`https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/${path}`, {
    ...init,
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "pool-chemical-uploader",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers || {}),
    },
  });
}

function corsHeaders(env, request) {
  const origin = request.headers.get("origin") || "*";
  const allowed = (env.ALLOWED_ORIGIN || "*").split(",").map((item) => item.trim());
  const allowOrigin = allowed.includes("*") || allowed.includes(origin) ? origin : allowed[0] || "*";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
    "Access-Control-Allow-Headers": "content-type, x-pool-upload-key",
    "Access-Control-Max-Age": "86400",
    "Content-Type": "application/json",
  };
}

function json(payload, headers, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers });
}
