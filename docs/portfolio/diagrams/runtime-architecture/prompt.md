# Runtime architecture redraw context

## Must preserve

- The reading path is top to bottom: product surface, local service, local data and models.
- React owns business data and applies approved writes; FastAPI and the Agent do not silently write renderer state.
- Electron manages the FastAPI sidecar on a random loopback port without exposing general Node capabilities to the page.
- LangGraph + Harness is the focal approval boundary, including permission, recovery, validation and Mutation Intent.
- Local hybrid retrieval uses BM25, BGE, RRF and Cross-Encoder; service data separates SQLite, DPAPI, Qdrant and structured logs.
- DeepSeek is the only node outside the device boundary and only receives an explicitly triggered minimal snapshot or evidence.
- The diagram describes the shipped 0.7.0 runtime, not future 0.8.0 portfolio work.

## Suggested additions

- Add a future offline Provider only after the runtime actually supports it and the roadmap commits to the boundary.
- Add a release signing boundary only if a later architecture document needs to explain installer trust; it does not belong in the runtime path today.
- If the renderer storage split becomes too dense, create a sister data lifecycle diagram instead of adding more nodes here.

## Visual direction

- Keep a top-to-bottom reading path and a maximum of nine nodes.
- Use warm parchment, ivory and warm gray with ink blue only for the Agent approval boundary and its primary request path.
- Use solid nodes for shipped components and a dashed outline only for the external Provider.
- Keep orthogonal connectors, open chevrons and masked edge labels; do not route lines through node text.
- Keep Chinese function-first names and short English mono anchors; no full-sentence translation inside the figure.
- Export from this HTML at 2880 pixels wide through `npm run portfolio:render-diagrams`; never resize or patch the PNG directly.

## Sister boundaries

- Agent approval states, three decisions and ACK behavior belong in `../../architecture.md` and `../../decisions-and-failures.md`, not as extra runtime nodes.
- Metrics and benchmark values belong in `../../evidence-map.md`; this diagram must not become a performance dashboard.
- Roadmap dates, owners and the 0.8.0 delivery sequence belong in the implementation plan, not in this architecture asset.
- Product screenshots and the narrative tour belong in `../../README.md`.
