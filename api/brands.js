import { findStationBrands, readJsonBody } from "../lib/fuel-data.mjs";

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const body = await readJsonBody(request);
    const brands = await findStationBrands(Array.isArray(body.stations) ? body.stations : []);
    response.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=3600");
    response.status(200).json({ brands });
  } catch (error) {
    console.error(error);
    response.status(500).json({ error: error.message });
  }
}
