# The same checks CI runs. Requires Node 24 and pnpm 10 (corepack enable).
.PHONY: verify install schemas conformance

install:
	pnpm install --frozen-lockfile

verify:
	pnpm verify

schemas:
	pnpm schemas

# Run against a server: make conformance URL=http://localhost:8787 IDENTITIES=conformance/identities.json
conformance:
	pnpm --filter @openmessageboard/conformance start --url $(URL) --identities $(abspath $(IDENTITIES))
