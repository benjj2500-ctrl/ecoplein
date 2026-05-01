const GITHUB_REPO = "benjj2500-ctrl/ecoplein";

// In-memory cache to avoid hammering GitHub API
let _cache = null;
let _cacheTs = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // Browser + CDN cache: 5 min fresh, 10 min stale
  res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");

  const now = Date.now();
  if (_cache && now - _cacheTs < CACHE_TTL_MS) {
    res.json(_cache);
    return;
  }

  try {
    const ghRes = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/commits?per_page=30`,
      { headers: { "User-Agent": "ecoplein-vercel-app" } }
    );

    if (!ghRes.ok) {
      throw new Error(`GitHub API ${ghRes.status}`);
    }

    const rawCommits = await ghRes.json();
    const currentSha = process.env.VERCEL_GIT_COMMIT_SHA || "";

    const commits = rawCommits.map((c) => {
      // Strip "Co-Authored-By" trailers and keep only the first line
      const firstLine = c.commit.message
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("Co-Authored-By:"))
        .at(0) || "";

      return {
        sha: c.sha.slice(0, 7),
        message: firstLine,
        date: c.commit.author.date,
        current: currentSha.length > 0 && c.sha.startsWith(currentSha.slice(0, 7)),
      };
    });

    const data = {
      // v1.N where N = total number of commits in history
      version: `v1.${commits.length}`,
      sha: currentSha ? currentSha.slice(0, 7) : "dev",
      commits,
    };

    _cache = data;
    _cacheTs = now;
    res.json(data);
  } catch (err) {
    console.error("version endpoint:", err);
    // Serve stale cache if available, otherwise error
    if (_cache) {
      res.json({ ..._cache, stale: true });
    } else {
      res.status(503).json({ error: "Historique indisponible" });
    }
  }
}
