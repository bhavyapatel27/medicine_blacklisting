# Cascade Plus Pack Optimisation Logic

Backup reference: **Pack opti 2610**  
Document date: **26 October 2026**

## 1. Purpose

Pack Optimisation is part of the existing Cascade optimisation framework. It is not a separate recommendation engine.

The shared framework supports:

- `BRAND_GENERIC` — switch between an approved Brand and Generic equivalent while retaining the basket quantity.
- `PACK_SIZE` — switch to another approved pack size and calculate how many whole alternative packs are needed.
- `PI` — reserved as a future strategy and currently disabled.

The shared framework owns mapping retrieval, supplier offers, pricing, candidate ranking, the Cheaper Alternatives drawer, individual and bulk switching, undo, audit, order history, reporting, estimated saving and confirmed saving. Only mapping validation and quantity conversion differ by optimisation strategy.

## 2. Separation of responsibilities

### Product Mapping in Admin

Product Mapping answers:

> Are these approved versions of the same clinical product in different pack sizes?

Admin establishes an approved, bidirectional Pack Equivalent relationship. It does not guarantee that a pair is suitable for every basket quantity.

### Order Pad optimisation engine

The Order Pad answers:

> For this basket quantity, current supplier price, available alternative supplier price and configured excess tolerance, is the switch commercially worthwhile and operationally sensible?

Eligibility is recalculated whenever the basket or relevant commercial data changes.

## 3. Shared optimisation flow

1. Collect the current basket lines.
2. Submit the basket in one request to the shared optimisation summary endpoint.
3. Batch-load validated relationship groups for all basket product IDs.
4. Batch-load eligible supplier offers for all mapped candidate products.
5. Select the appropriate strategy for each relationship type.
6. Calculate the candidate basket quantity.
7. Apply supplier, customer, product, availability and Drug Tariff rules.
8. Calculate unit costs, total costs, excess and saving.
9. Reject candidates that fail any eligibility rule.
10. Rank all valid candidates for a basket line.
11. Return the cheapest valid candidate, preferring an exact conversion when total costs are within one penny.
12. Return a lightweight summary before the drawer is opened.
13. Load full opportunity details when the Cheaper Alternatives drawer opens.

The engine returns at most one best opportunity for each basket line at a time.

## 4. Configuration

Backend configuration is read from environment variables and normalised into the shared optimisation settings object.

| Setting | Environment variable | Default | Meaning |
| --- | --- | ---: | --- |
| Pack Optimisation enabled | `PACK_OPTIMISATION_ENABLED` | `true` | Enables or disables Pack Size opportunities without removing mappings. |
| Maximum excess percentage | `PACK_MAXIMUM_EXCESS_PERCENTAGE` | `10` | Maximum acceptable round-up excess for a Pack Size opportunity. |

The static wireframe fallback uses the same defaults:

```text
packOptimisationEnabled = true
maximumExcessPercentage = 10
```

The percentage is configuration-driven and is not repeated as a fixed business rule throughout the calculation code.

## 5. Pack Equivalent mapping

Pack equivalents use the shared relationship-group data model:

```text
product_relationship_group
product_relationship_group_member
```

The Pack relationship type is:

```text
PACK_SIZE
```

Pack group codes use the form:

```text
PACK-GRP-000001
```

A relationship is stored once as a group. Opening any member can display the other approved group members. The relationship graph is bidirectional, but opportunity eligibility remains directional because it depends on the current basket quantity.

Only members with `Valid` or `Validated` status can generate live opportunities. `Needs Review` and `Invalid` members are excluded.

## 6. Admin validation

The following core attributes must match for a valid Pack Equivalent:

- Active ingredient or ingredient combination
- Strength
- Dosage form
- Route
- Release type
- Formulation modifier
- Comparable pack unit
- Product family or clinical identity

The expected difference is the structured pack quantity. Products with identical structured pack quantities are not valid Pack Equivalent candidates.

Examples:

```text
Valid:
Paracetamol 500mg caplets x100
Paracetamol 500mg caplets x22

Invalid:
Paracetamol 500mg tablets
Paracetamol oral solution
```

Admin may show an indicative one-pack conversion, but final eligibility is always recalculated using the live basket quantity, prices and excess tolerance.

### Admin comparison results

- Core Match — positive.
- Pack Variant — positive and expected.
- Exact Conversion — positive.
- Round-up Eligible — positive or neutral, with excess displayed.
- Excess Too High — review/amber; no live opportunity for that basket direction.
- Invalid Match — red; mapping cannot be validated.

Pack size being different is not treated as an error.

## 7. Product data changes and revalidation

Changes to any of the following fields require Pack mappings involving that product to be reviewed:

- Ingredient or strength
- Dosage form
- Route
- Release type
- Formulation modifier
- Pack quantity or pack size
- Pack unit
- Comparable quantity or comparable unit
- Product family

When one of these fields changes:

1. The product-master change is audited.
2. Affected direct mappings and relationship-group members are marked `Needs Review`.
3. Their validation metadata is cleared where applicable.
4. They stop producing live Order Pad opportunities until an administrator revalidates them.

## 8. Pack quantity calculation

Definitions:

```text
CurrentPackQuantity        = comparable units in the current pack
AlternativePackQuantity    = comparable units in the alternative pack
CurrentBasketQuantity      = number of current packs requested
```

Required units:

```text
RequiredUnits = CurrentPackQuantity × CurrentBasketQuantity
```

Alternative pack count:

```text
AlternativeBasketQuantity = CEILING(RequiredUnits / AlternativePackQuantity)
```

Alternative supplied units:

```text
AlternativeSuppliedUnits = AlternativeBasketQuantity × AlternativePackQuantity
```

Excess:

```text
ExcessUnits = AlternativeSuppliedUnits - RequiredUnits
ExcessPercentage = (ExcessUnits / RequiredUnits) × 100
```

Only whole alternative packs are recommended. A small numerical epsilon is used before `CEILING` so floating-point noise does not turn a mathematically exact result into an extra pack.

### Exact conversion

```text
ExcessUnits = 0
ConversionType = EXACT
```

Example:

```text
Current:     3 × 100 = 300 tablets
Alternative: 6 × 50 = 300 tablets
Result:      Exact quantity match
```

### Controlled round-up

```text
ExcessUnits > 0
ConversionType = ROUND_UP
```

Example with a 10% tolerance:

```text
Current:     1 × 100 = 100 tablets required
Alternative: 5 × 22 = 110 tablets supplied
Excess:      10 tablets = 10%
Result:      Eligible when all commercial checks also pass
```

## 9. Directional eligibility

Mapping is bidirectional; recommendations are not blindly bidirectional.

```text
100-pack Qty 1 → 22-pack Qty 5
Required 100, supplied 110, excess 10%
Potentially eligible

22-pack Qty 1 → 100-pack Qty 1
Required 22, supplied 100, excess 354.5%
Not eligible at a 10% tolerance
```

Basket quantity can change the result:

```text
100-pack Qty 3 → 30-pack Qty 10
Required 300, supplied 300
Exact conversion
```

The direction and actual basket quantity must therefore be evaluated at Order Pad runtime.

## 10. Pricing calculations

Unit costs:

```text
CurrentUnitCost = CurrentPackPrice / CurrentPackQuantity
AlternativeUnitCost = AlternativePackPrice / AlternativePackQuantity
```

Total costs:

```text
CurrentTotalCost = CurrentPackPrice × CurrentBasketQuantity
AlternativeTotalCost = AlternativePackPrice × AlternativeBasketQuantity
```

Estimated saving:

```text
EstimatedSaving = CurrentTotalCost - AlternativeTotalCost
```

Cheaper unit cost alone is insufficient. The alternative must also have a lower total cost after the required whole-pack round-up.

All displayed monetary totals and savings are rounded to two decimal places. The underlying unit-cost comparison is retained at sufficient precision.

## 11. Final Pack Size eligibility rule

A Pack Size opportunity is returned only when every applicable condition is true:

```text
Pack Optimisation is enabled
AND mapping status is Valid or Validated
AND core product attributes match
AND product family matches
AND comparable pack units are compatible
AND current basket quantity is positive
AND both comparable pack quantities are positive
AND alternative pack quantity is calculated with CEILING
AND alternative supplied units are at least the required units
AND excess percentage is within the configured tolerance
AND an eligible supplier offer exists
AND supplier/customer/product rules allow the offer
AND offer price does not exceed the product Drug Tariff price
AND alternative unit cost is lower than current unit cost
AND alternative total cost is lower than current total cost
AND estimated saving is greater than zero
```

If any rule fails, the candidate is not shown to the pharmacy.

## 12. Best candidate selection

Every approved candidate in the current product's Pack Equivalent group is evaluated. The engine does not choose by smallest pack or cheapest individual pack price.

Ranking is:

1. Reject invalid or unavailable candidates.
2. Sort remaining candidates by lowest alternative total cost.
3. When total costs differ by no more than £0.01, prefer `EXACT` over `ROUND_UP`.
4. Use product ID as a deterministic final tie-breaker.

This implements the commercial goal while favouring no-excess conversions when savings are reasonably equivalent.

## 13. Shared opportunity model

The Pack Size opportunity uses the common optimisation shape and populates the Pack-specific quantity fields:

```text
optimisationType = PACK_SIZE
optimisationTypeLabel = Pack Size

lineId
mappingId
equivalentGroupId
mappingStatus

originalProductId / currentProductId
alternativeProductId / replacementProductId
originalProductName / currentName
alternativeProductName / replacementName
originalPipCode / currentPip
alternativePipCode / replacementPip

currentPackQuantity
alternativePackQuantity
comparableUnit
currentBasketQuantity
alternativeBasketQuantity
requiredUnits
alternativeSuppliedUnits
excessUnits
excessPercentage
conversionType

currentPackPrice
alternativePackPrice
currentUnitCost
alternativeUnitCost
currentTotalCost
alternativeTotalCost
estimatedSaving / totalSaving

currentSupplier
recommendedSupplier
recommendedOffer
```

Aliases are retained in parts of the wireframe for compatibility with the original Brand Equalisation integration.

## 14. API contract

The common Order Pad API is:

```text
POST /api/order-pad/optimisation/summary
POST /api/order-pad/optimisation/details
POST /api/order-pad/optimisation/switch
POST /api/order-pad/optimisation/undo
POST /api/order-pad/optimisation/confirm
```

The legacy path remains an alias for compatibility:

```text
/api/order-pad/brand-equalisation/*
```

Admin uses the shared product mapping and optimisation history endpoints. The static preview can fall back to its embedded approved mapping snapshot and browser storage when the API is unavailable.

## 15. Performance behavior

The service does not issue separate mapping and pricing queries per basket line.

The backend:

1. Deduplicates all basket product IDs.
2. Fetches validated Brand/Generic and Pack Size group candidates in one relationship query.
3. Joins product master and eligible supplier offers in the same candidate load.
4. Groups the returned candidates in memory by source product ID.
5. Performs Pack arithmetic in memory for each relevant basket line.

The basket is limited to 500 lines per opportunity request.

## 16. Cheaper Alternatives drawer

Brand/Generic and Pack Size remain one optimisation experience.

### Organisation

- Filters: `All`, `Brand ↔ Generic`, `Pack Size`.
- The All view groups cards under separate Brand/Generic and Pack Size section headers.
- Each header shows the suggestion count, potential saving and selected count when applicable.
- Sections can be collapsed without losing selection.
- Section headers are sticky while scrolling.
- Filters and section collapse operate locally and do not re-fetch supplier prices.
- The footer remains fixed.

The card-level type badges were removed because the filter and section heading already identify the optimisation type.

### Pack Size card

The Pack card shows:

- Current product and alternative side-by-side.
- Current and alternative basket quantities.
- Price per pack.
- Unit cost without a list dot or bullet.
- The conversion, for example `1 × 100 → 5 × 22`.
- For exact conversions, `Exact quantity match`.
- For round-up conversions, required/supplied quantity and visible excess, for example `+10 tablets · 10% excess`.
- Total saving.
- Individual Switch action.

Valid excess is informational and uses a subtle amber treatment; it is not presented as an error.

### Visual state

- Normal cards alternate between white and a very light cool grey.
- Selection overrides the zebra colour with a very pale green background, green checkbox and thin green outline.
- Green is reserved for actions, savings, exact match and selected state.
- The drawer overlays the Order Pad and does not resize the basket.

## 17. Selection and switch behavior

The control model is:

```text
Checkbox       = choose for a later bulk action
Switch         = switch this one opportunity now
Switch Selected = switch checked opportunities only
Switch All     = switch every eligible opportunity in the current filter scope
```

Selecting a checkbox never changes the basket immediately.

Selection survives filtering and section collapse. An individual switch does not execute other checked items. After an individual switch, the successful opportunity is removed and other still-valid selections remain selected.

`Switch All` follows the active filter:

- `All` — all visible optimisation types.
- `Brand ↔ Generic` — Brand/Generic only.
- `Pack Size` — Pack Size only.

Bulk processing is not all-or-nothing. Successful switches remain applied if another selected line fails revalidation; the failed line remains available with an explanation.

## 18. Confirmation behavior

### Individual Pack Size switch

The individual Pack confirmation deliberately mirrors the simple Brand/Generic confirmation because detailed pricing, unit cost and excess are already visible on the card.

It shows only:

```text
Switch this product?

Current
Switch to
Quantity: 1 pack → 5 packs
Estimated saving

Cancel | Switch Product
```

It does not repeat required units, supplied units, extra units, unit costs or conversion status.

### Bulk switch

The bulk confirmation shows:

- Number of products being switched.
- Count by optimisation type.
- Estimated combined saving.

The previous scrolling list of Pack Size product details was removed from bulk confirmation. All item-level conversion and excess detail is reviewed on the cards before the bulk action.

## 19. Applying a switch and undo

At switch time the selected basket line is updated to the recommended product, supplier offer and recommended basket quantity.

The switch record snapshots:

- Original product ID, name and PIP code
- Original pack quantity
- Original basket quantity
- Original supplier
- Original pack price
- Original unit cost
- Original total cost
- Recommended product and supplier
- Final requested pack and basket quantities
- Required and supplied comparable units
- Excess units and percentage
- Conversion type
- Estimated saving
- User, customer, time, order reference and switch source

The original price snapshot is the historical baseline. It is not recalculated later from refreshed supplier prices.

Undo is recorded as a separate audit event and restores the original product, pack size, basket quantity and supplier state on the same basket line. Product changes are not undoable after the order has been submitted.

## 20. Supplier cascade and confirmed saving

After a Pack Size switch, the alternative follows the existing supplier cascade. Pack Optimisation does not create a separate fulfilment route.

Example:

```text
Original snapshot:               £2.00
Recommended supplier estimate: 5 × £0.36 = £1.80
Estimated saving:                £0.20

Recommended supplier fails.
Next supplier accepts:          5 × £0.37 = £1.85
Confirmed saving:               £2.00 - £1.85 = £0.15
```

Failed supplier attempts do not receive confirmed saving.

### Partial fulfilment

For each successful supplier outcome:

```text
ComparableFulfilled = ReceivedAlternativePacks × AlternativePackQuantity
BaselineUnits = MIN(ComparableFulfilled, RemainingRequiredUnits)
OriginalBaselineCost = OriginalUnitCostSnapshot × BaselineUnits
AcceptedAlternativeCost = AcceptedPackPrice × ReceivedAlternativePacks
ConfirmedSavingContribution = OriginalBaselineCost - AcceptedAlternativeCost
```

Confirmed saving is the sum of successful contributions. No original-cost baseline is claimed beyond the required comparable quantity, and no saving is claimed for unfulfilled stock.

The accepted outcomes also determine the final accepted pack price and final unit cost recorded in history.

## 21. Audit, order history and reporting

Pack Size changes use the existing product-change history and reports.

The optimisation audit records:

- Original and final products
- Original and final pack sizes
- Original and final basket quantities
- Required and final supplied units
- Excess units and percentage
- Original and accepted pack prices
- Original and final unit costs
- Estimated and confirmed saving
- `Optimisation Type = PACK_SIZE`
- Changed by and changed at
- Switch, undo and confirmation events

Order History counts changed basket lines, not supplier attempts. `View Product Changes (X)` includes Brand/Generic and Pack Size changes together.

The Product Change report uses `Change Type = Pack Size`, shows confirmed saving only for a successful accepted supplier outcome and shows a dash for failed supplier attempts.

The shared report filter supports:

```text
All
Product Changes Only
Brand ↔ Generic
Pack Size
PI
No Optimisation
```

No separate Pack Optimisation report is introduced.

## 22. Required scenarios

### A. Exact conversion

```text
Current:     100 pack × 1 at £2.00
Alternative: 50 pack × 2 at £0.80
Supplied:    100
Cost:        £1.60
Saving:      £0.40
Result:      EXACT and eligible
```

### B. Allowed round-up

```text
Current:     100 pack × 1 at £2.00
Alternative: 22 pack × 5 at £0.36
Supplied:    110
Excess:      10 units / 10%
Cost:        £1.80
Saving:      £0.20
Result:      ROUND_UP and eligible at a 10% tolerance
```

### C. Too much excess

```text
Current:     22 pack × 1
Alternative: 100 pack × 1
Excess:      78 units / 354.5%
Result:      Not eligible
```

### D. Cheaper unit price but expensive order

If alternative unit cost is lower but whole-pack rounding makes the alternative total cost equal to or greater than the current total cost, it is not eligible.

### E. Excess above tolerance

```text
Required:    100
Alternative: 30 pack × 4 = 120
Excess:      20%
Tolerance:   10%
Result:      Not eligible
```

### F. Basket quantity changes eligibility

```text
Current:     100 pack × 3 = 300 required
Alternative: 30 pack × 10 = 300 supplied
Result:      Exact for this basket
```

## 23. Explicitly out of scope

This implementation does not provide:

- Mixed-pack combinations
- Dose-equivalence conversion
- Different dosage-form conversion
- Unapproved mappings
- Automatic switching
- Minimum-stock recommendations
- Demand forecasting
- Complex excess-stock valuation

## 24. Main implementation locations

### Frontend

```text
Pack opti - front/Brand+Smart/brand-equalisation.js
Pack opti - front/Brand+Smart/app.js
Pack opti - front/Brand+Smart/brand-equalisation.css
Pack opti - front/Brand+Smart/order-report.js
Pack opti - front/Brand+Smart/tests/optimisation-engine.test.js
```

### Backend and Admin

```text
Pack opti - Admin/Brand Equilization - Admin 9_10/server/optimisation-service.js
Pack opti - Admin/Brand Equilization - Admin 9_10/server/brand-equalisation-service.js
Pack opti - Admin/Brand Equilization - Admin 9_10/server/app.js
Pack opti - Admin/Brand Equilization - Admin 9_10/server/config.js
Pack opti - Admin/Brand Equilization - Admin 9_10/server/migrations/016_shared_optimisation_framework.sql
Pack opti - Admin/Brand Equilization - Admin 9_10/server/migrations/017_optimisation_audit_events.sql
Pack opti - Admin/Brand Equilization - Admin 9_10/server/migrations/018_pack_optimisation_example.sql
Pack opti - Admin/Brand Equilization - Admin 9_10/server/migrations/019_pack_optimisation_round_up.sql
Pack opti - Admin/Brand Equilization - Admin 9_10/server/migrations/020_pack_optimisation_order_pad_examples.sql
Pack opti - Admin/Brand Equilization - Admin 9_10/test/brand-equalisation-api.test.js
Pack opti - Admin/Brand Equilization - Admin 9_10/test/brand-equalisation.test.js
Pack opti - Admin/Brand Equilization - Admin 9_10/test/products-admin.test.js
```

## 25. Restore and run

The backup excludes `node_modules` and generated preview build output. Restore dependencies from the included lockfiles.

Backend/Admin:

```powershell
cd "Pack opti - Admin\Brand Equilization - Admin 9_10"
npm ci
npm test
npm start
```

Frontend tests and static preview:

```powershell
cd "Pack opti - front\Brand+Smart"
npm ci
npm test
npm run build:preview
npm run test:preview
```

The backend defaults to port `3100` and serves the frontend from the corresponding `Pack opti - front/Brand+Smart` directory.

