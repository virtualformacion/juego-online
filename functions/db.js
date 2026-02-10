const json = (statusCode, obj) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  },
  body: JSON.stringify(obj)
});

function b64encode(str) {
  return Buffer.from(str, "utf8").toString("base64");
}
function b64decode(b64) {
  return Buffer.from(b64, "base64").toString("utf8");
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return json(200, { ok: true });

    const {
      GITHUB_TOKEN,
      GITHUB_REPO,
      GITHUB_FILE_PATH,
      GITHUB_BRANCH = "main"
    } = process.env;

    if (!GITHUB_TOKEN || !GITHUB_REPO || !GITHUB_FILE_PATH) {
      return json(500, { error: "Faltan variables de entorno en Netlify (GITHUB_TOKEN, GITHUB_REPO, GITHUB_FILE_PATH)." });
    }

    const apiBase = `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_FILE_PATH}`;
    const headers = {
      "Authorization": `token ${GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "netlify-function-db"
    };

    if (event.httpMethod === "GET") {
      const r = await fetch(`${apiBase}?ref=${encodeURIComponent(GITHUB_BRANCH)}`, { headers });
      if (!r.ok) return json(r.status, { error: await r.text() });

      const file = await r.json();
      const content = b64decode(file.content);
      return json(200, { sha: file.sha, data: JSON.parse(content) });
    }

    if (event.httpMethod === "POST") {
      const body = event.body ? JSON.parse(event.body) : {};
      const data = body.data;
      const message = body.message || "Update db.json";

      if (!data) return json(400, { error: "Falta 'data' en el body." });

      const r0 = await fetch(`${apiBase}?ref=${encodeURIComponent(GITHUB_BRANCH)}`, { headers });
      if (!r0.ok) return json(r0.status, { error: await r0.text() });
      const file = await r0.json();

      const newContent = b64encode(JSON.stringify(data, null, 2));

      const r1 = await fetch(apiBase, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          message,
          content: newContent,
          sha: file.sha,
          branch: GITHUB_BRANCH
        })
      });

      if (!r1.ok) return json(r1.status, { error: await r1.text() });
      return json(200, { ok: true });
    }

    return json(405, { error: "Method not allowed" });
  } catch (e) {
    return json(500, { error: String(e?.message || e) });
  }
};
