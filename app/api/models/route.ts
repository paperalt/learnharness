import { ensureNineRouterCatalog, modelCatalog } from "@/src/server";

/**
 * The model picker's data (model-control wave): pi-ai's configured-provider
 * catalog as client-safe DTOs — id/name/cost/context/modality plus each
 * model's SUPPORTED thinking levels (per its thinkingLevelMap). Static
 * catalogs need no network; DYNAMIC providers (9Router) refresh on demand
 * before projection — an empty 9Router catalog is awaited (up to the
 * refresh timeout), a warm one is revalidated in the background.
 */
export async function GET() {
	await ensureNineRouterCatalog();
	return Response.json(modelCatalog());
}
