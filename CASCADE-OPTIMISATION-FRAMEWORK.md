# Cascade optimisation framework

Brand/Generic, Pack Size and PI run through one optimisation process.

## Shared flow

1. The Order Pad submits all basket lines to `POST /api/order-pad/optimisation/summary`.
2. The service loads validated relationship-group members and eligible supplier offers in one batch query.
3. A strategy supplies only its type-specific quantity rule:
   - `BRAND_GENERIC`: preserve basket quantity and require compatible equal packs.
   - `PACK_SIZE`: supply the required comparable quantity with whole packs, within the configured excess tolerance.
   - `PI`: require a validated PI/reference relationship and matching structured medicine attributes and marketed packs; preserve basket quantity.
4. The shared engine applies supplier/customer/product availability, Drug Tariff and total-cost rules and returns the cheapest valid option per line.
5. Details are loaded lazily from `/details` when the existing Cheaper Alternatives drawer opens.
6. The existing single/bulk switch and undo paths apply the strategy's recommended basket quantity.
7. The switch snapshots original product, pack, quantity, supplier, comparison price and total cost in `optimisation_switch_history`.
8. Supplier outcomes can be confirmed through `/confirm`; only successful fulfilled comparable quantity contributes to confirmed saving.

The previous `/api/order-pad/brand-equalisation/*` endpoints and `CascadeBrandEqualisation` browser global remain compatibility aliases to the shared service.

## Relationship data

`product_relationship_group` and `product_relationship_group_member` hold bidirectional groups for `BRAND_GENERIC`, `PACK_SIZE` and `PI`. A product can belong to one group per relationship type. Legacy mappings are migrated idempotently into the shared groups.

Pack validation uses structured ingredients/strengths, dosage form, route, release type, formulation modifier, product family, comparable quantity and comparable unit. Product-master changes to these fields mark affected group members `Needs Review`, immediately excluding them from customer-facing opportunities.

## Pack rule

```text
required comparable quantity = original pack quantity × original basket quantity
recommended basket quantity  = ceil(required comparable quantity / alternative pack quantity)
```

The alternative is eligible only when its supplier-priced total and comparable unit cost are lower and excess quantity stays within the existing configured tolerance. There is no mixed-pack solving, clinical-form conversion or automatic switching.

## Phase 1 PI

`shared/optimisation-validation.js` is the single structured PI validator used by Product Mapping Admin, the batch service and the offline Order Pad. PI never uses fuzzy product-name matching. Ingredient/strength, form, route, release, marketed pack quantity/unit and comparable pack quantity/unit must match. The PI must be active and reference the UK product (or share the same reference within an approved group). Optional licence dates, when present, must be current. PLPI numbers are stored where available; they are not required when the source dataset does not provide them.

PI mappings use the existing bidirectional relationship groups and require `Validated` membership on both ends. Existing legacy `Valid` PI mappings move to `Needs Review` in migration `023_pi_optimisation.sql`. Structured product and PI metadata changes through Product Master invalidate the relevant relationship memberships. PI target products cannot enter through Brand/Generic or Pack relationships to bypass permission or validation. The existing cheapest-per-line selection therefore returns one card per line/target with PI classification taking precedence.

PI is enabled by default alongside Brand/Generic and Pack Size, in both the local preview and served application. There is no PI control in customer Settings. Previous browser preferences from that removed control are ignored. Backend business restrictions remain available: `optimisation_customer_rule.allow_pi` can override `ALLOW_PI_ALTERNATIVES` (default ON). The existing customer identity integration supplies `x-customer-id` to summary, details and switch requests; the demo account is `DEMO-PHARMACY`. The customer-rules write endpoint uses the existing administrator/CSRF gateway. As with the existing application authentication seam, production must bind these headers to the authenticated account upstream.

The rules JSON reserves space for future exclusions, supplier preferences and thresholds without introducing another pricing path. A backend business restriction excludes PI opportunities, counts and bulk actions while preserving Admin mappings. Eligibility is rechecked when switching. The offline prototype uses the default-enabled shared strategy, validator and quantity rule. The built preview includes the shared modules as hashed assets.

All PI offers enter the same batch supplier query and Drug Tariff, availability and total-cost rules. For quantity 4, £8.50 versus £7.30 gives £34.00 versus £29.20 and estimated saving £4.80. No pack conversion or combined optimisation is supported for PI.

The existing drawer dynamically renders the PI tab/section, shared confirmation and mixed selection. The existing Undo restores the original basket state. Audit stores original and final product types, PI reference and available PLPI information alongside the immutable original pricing snapshot. `/confirm` uses successful supplier outcomes; B&S OOS followed by AAH at £7.40 yields confirmed saving £4.40. Order History counts changed lines; Product Changes reports show PI and leave failed-attempt savings blank.

The existing local fulfilment simulation is unchanged. Real supplier adapters must continue posting accepted outcomes to the shared `/confirm` endpoint; PI has no separate cascade. Regulatory metadata appears only in Admin/audit, not in the customer comparison cards.

`shared/optimisation-pi-fixture.js` supplies an explicitly illustrative Lipitor example for the offline prototype and non-production fixture import. Its licence value is `DEMO ONLY`; it is not a real regulatory verification record. Fixture import is skipped in production and when `seed: false` is used. Existing example products/mappings are not recreated on restart after an administrator changes them.

## Verification

- Frontend: `npm test`, `npm run build:preview`, `npm run test:preview` in `Pack opti - front/Brand+Smart`.
- Backend/Admin: `npm test` in `Pack opti - Admin/Brand Equilization - Admin 9_10`.
- PI API tests cover pricing, permissions, packs, mapping status, regulatory fields, revalidation, deduplication, persistence and supplier fallback against the original snapshot.
- PI browser tests cover default-enabled local/served flows, absence of PI Settings controls, Admin validation, mixed bulk, filter scope, individual switch, Undo, changed-line count and report outcomes.
- Visual checks: `artifacts/pi-drawer.png` and `artifacts/pi-admin-validation.png`.
