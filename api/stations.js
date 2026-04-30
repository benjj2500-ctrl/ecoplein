import { getStationRows } from "../lib/fuel-data.mjs";

export default async function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const ids = String(request.query?.ids || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
      .slice(0, 5);
    const stations = await getStationRows({
      fuel: request.query?.fuel,
      latitude: request.query?.lat,
      longitude: request.query?.lon,
      ids,
      force: request.query?.fresh === "1",
    });

    response.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=300");
    response.status(200).json({ stations });
  } catch (error) {
    console.error(error);
    response.status(500).json({ error: error.message });
  }
}
