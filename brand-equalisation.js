// Shared Cascade optimisation framework for Brand/Generic, Pack Size and PI.
// Approved relationship graph, strategy conversion, supplier comparison and audit adapter.
(function initialiseBrandEqualisation(global) {
  "use strict";

  const ADMIN_STORAGE_KEY = "cascade-products-admin-phase-1";
  const HISTORY_STORAGE_KEY = "cascade-brand-equalisation-history-v1";
  const VALID_STATUS = "valid";
  const API_ROOT = "/api/order-pad/optimisation";
  const DEFAULT_OPTIMISATION_CONFIG = Object.freeze({
    allowPIAlternatives: true,
    packOptimisationEnabled: true,
    maximumExcessPercentage: 10
  });
  const QUANTITY_EPSILON = 1e-9;
  const COMPARABLE_SAVING_EPSILON = 0.01;
  const staticPreview = /\/Cart-Highlights-and-Warning-preview(?:\/|$)/i.test(global.location?.pathname || "");
  let apiState = /^https?:$/i.test(global.location?.protocol || "") && !staticPreview ? "unknown" : "offline";

  // Compact server-snapshot stand-in for the wireframe. In production this shape is
  // returned by the Product Mapping endpoint and refreshed when Admin mappings change.
  const approvedMappingSnapshot = [
    { sourceProductId: "147768", replacementProductId: "80872", status: "Valid", mappingType: "brand" },
    { sourceProductId: "900101", replacementProductId: "900111", status: "Valid", mappingType: "brand" },
    { sourceProductId: "900102", replacementProductId: "900112", status: "Valid", mappingType: "brand" },
    { sourceProductId: "900103", replacementProductId: "900113", status: "Valid", mappingType: "brand" },
    { sourceProductId: "101067", replacementProductId: "89728", status: "Valid", mappingType: "brand" },
    { sourceProductId: "103758", replacementProductId: "104666", status: "Valid", mappingType: "brand" },
    { sourceProductId: "PACK100", replacementProductId: "PACK50", status: "Valid", mappingType: "pack" },
    { sourceProductId: "p6", replacementProductId: "PACK-ALFA-60", status: "Valid", mappingType: "pack" },
    { sourceProductId: "p26", replacementProductId: "PACK-AMOX-16", status: "Valid", mappingType: "pack" },
    { sourceProductId: "PACK-CET-100", replacementProductId: "PACK-CET-22", status: "Valid", mappingType: "pack" },
    { sourceProductId: "PACK-VITD-3", replacementProductId: "PACK-VITD-10", status: "Valid", mappingType: "pack" }
  ];

  function readAdminMappings() {
    try {
      const saved = JSON.parse(global.localStorage.getItem(ADMIN_STORAGE_KEY) || "null");
      return saved && saved.mappings && typeof saved.mappings === "object"
        ? saved.mappings
        : null;
    } catch (_error) {
      return null;
    }
  }

  // Valid approved links, expanded both ways: every member of a connected group can replace every other member.
  function approvedMappings() {
    const byTypeAndSource = new Map();
    [...approvedMappingSnapshot, ...(global.CascadePIExample ? [global.CascadePIExample.mapping] : [])].forEach((mapping) => {
      const key = `${mapping.mappingType}:${mapping.sourceProductId}`;
      if (!byTypeAndSource.has(key)) byTypeAndSource.set(key, []);
      byTypeAndSource.get(key).push({ ...mapping });
    });

    // A source present in Admin storage is authoritative, so an Admin unlink or status
    // downgrade cannot be reintroduced by the compact fallback snapshot.
    const adminMappings = readAdminMappings();
    if (adminMappings) {
      const authoritativeSources = new Set(Object.keys(adminMappings));
      for (const [key, mappings] of byTypeAndSource) {
        byTypeAndSource.set(key, mappings.filter((mapping) => !authoritativeSources.has(mapping.replacementProductId)));
      }
      Object.entries(adminMappings).forEach(([sourceProductId, mappingGroups]) => {
        ["brand", "pack", "pi"].forEach((mappingType) => {
          const mappings = Array.isArray(mappingGroups?.[mappingType]) ? mappingGroups[mappingType] : [];
          byTypeAndSource.set(`${mappingType}:${sourceProductId}`, mappings.map((mapping) => ({
            sourceProductId: String(sourceProductId),
            replacementProductId: String(mapping.id),
            status: String(mapping.status || ""),
            mappingType,
            linkedOn: mapping.linkedOn || "",
            createdBy: mapping.createdBy || ""
          })));
        });
      });
    }

    const expanded = [];
    ["brand", "pack", "pi"].forEach((mappingType) => {
      const pairs = Array.from(byTypeAndSource.values()).flat().filter((mapping) => mapping.mappingType === mappingType);
      const pairKey = (mapping) => [mapping.sourceProductId, mapping.replacementProductId].sort().join(":");
      const blocked = new Set(pairs.filter((mapping) => !["valid", "validated"].includes(String(mapping.status).trim().toLowerCase()))
        .map(pairKey));
      const validPairs = pairs
        .filter((mapping) => mapping.mappingType === mappingType
          && !blocked.has(pairKey(mapping))
          && (mappingType === "pi" ? String(mapping.status).trim().toLowerCase() === "validated"
            : [VALID_STATUS, "validated"].includes(String(mapping.status).trim().toLowerCase())));
      if (mappingType === "pi") {
        validPairs.forEach((mapping) => expanded.push({ ...mapping, equivalentGroupId: `LOCAL-PI-${mapping.sourceProductId}-${mapping.replacementProductId}` }));
        return;
      }
      const graph = new Map();
      validPairs.forEach((mapping) => {
        const source = String(mapping.sourceProductId);
        const replacement = String(mapping.replacementProductId);
        if (!graph.has(source)) graph.set(source, new Set());
        if (!graph.has(replacement)) graph.set(replacement, new Set());
        graph.get(source).add(replacement);
        graph.get(replacement).add(source);
      });
      const visited = new Set();
      for (const start of graph.keys()) {
        if (visited.has(start)) continue;
        const stack = [start];
        const members = [];
        while (stack.length) {
          const current = stack.pop();
          if (visited.has(current)) continue;
          visited.add(current);
          members.push(current);
          (graph.get(current) || []).forEach((next) => stack.push(next));
        }
        const prefix = mappingType === "pack" ? "PACK-GRP" : mappingType === "pi" ? "PI-GRP" : "EQ";
        const equivalentGroupId = `LOCAL-${prefix}-${members.slice().sort().join("-")}`;
        members.forEach((sourceProductId) => members
          .filter((replacementProductId) => replacementProductId !== sourceProductId)
          .forEach((replacementProductId) => expanded.push({
            sourceProductId, replacementProductId, mappingType, status: mappingType === "pi" ? "Validated" : "Valid", equivalentGroupId
          })));
      }
    });
    return expanded;
  }

  function money(value) {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
  }

  function positiveNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
  }

  function structuredPack(product = {}) {
    const text = String(product.packSize || "").trim();
    const match = text.match(/(\d+(?:\.\d+)?)\s*([a-zA-Z]+)?\s*$/);
    const packQuantity = positiveNumber(product.packQuantity) || positiveNumber(match?.[1]);
    const packUnit = String(product.packUnit || match?.[2] || "").trim();
    const secondaryQuantity = positiveNumber(product.secondaryPackQuantity ?? product.secondaryQuantity);
    const secondaryUnit = String(product.secondaryPackUnit ?? product.secondaryUnit ?? "").trim();
    return {
      packQuantity,
      packUnit,
      comparableQuantity: positiveNumber(product.comparableQuantity) || secondaryQuantity || packQuantity,
      comparableUnit: String(product.comparableUnit || secondaryUnit || packUnit).trim(),
    };
  }

  function compatibleUnit(left, right) {
    const canonical = (value) => String(value || "").trim().toLowerCase().replace(/s$/, "");
    return Boolean(canonical(left)) && canonical(left) === canonical(right);
  }

  const strategies = {
    brand: {
      type: "BRAND_GENERIC",
      label: "Brand ↔ Generic",
      convert(current, replacement) {
        const currentPack = structuredPack(current);
        const replacementPack = structuredPack(replacement);
        if (!currentPack.comparableQuantity || !replacementPack.comparableQuantity
          || !compatibleUnit(currentPack.comparableUnit, replacementPack.comparableUnit)
          || Math.abs(currentPack.comparableQuantity - replacementPack.comparableQuantity) > 1e-9) return null;
        return {
          originalPack: currentPack,
          replacementPack,
          recommendedBasketQuantity: current.quantity,
          requiredComparableQuantity: currentPack.comparableQuantity * current.quantity,
        };
      },
    },
    pack: {
      type: "PACK_SIZE",
      label: "Pack Size",
      convert(current, replacement, settings) {
        if (!settings.packOptimisationEnabled) return null;
        const currentPack = structuredPack(current);
        const replacementPack = structuredPack(replacement);
        if (!currentPack.comparableQuantity || !replacementPack.comparableQuantity
          || !compatibleUnit(currentPack.comparableUnit, replacementPack.comparableUnit)) return null;
        const currentFamily = String(current.productFamily || current.productFamilyId || "").trim().toLowerCase();
        const replacementFamily = String(replacement.productFamily || replacement.productFamilyId || "").trim().toLowerCase();
        if (!currentFamily || !replacementFamily || currentFamily !== replacementFamily) return null;
        const requiredComparableQuantity = currentPack.comparableQuantity * current.quantity;
        const quotient = requiredComparableQuantity / replacementPack.comparableQuantity;
        const recommendedBasketQuantity = Math.ceil(quotient - QUANTITY_EPSILON);
        if (recommendedBasketQuantity <= 0) return null;
        const alternativeSuppliedUnits = recommendedBasketQuantity * replacementPack.comparableQuantity;
        const excessUnits = Math.max(0, alternativeSuppliedUnits - requiredComparableQuantity);
        const excessPercentage = requiredComparableQuantity > 0
          ? (excessUnits / requiredComparableQuantity) * 100
          : Number.POSITIVE_INFINITY;
        if (alternativeSuppliedUnits + QUANTITY_EPSILON < requiredComparableQuantity
          || excessPercentage > settings.maximumExcessPercentage + QUANTITY_EPSILON) return null;
        return {
          originalPack: currentPack,
          replacementPack,
          recommendedBasketQuantity,
          requiredComparableQuantity,
          alternativeSuppliedUnits,
          excessUnits,
          excessPercentage,
          conversionType: excessUnits <= QUANTITY_EPSILON ? "EXACT" : "ROUND_UP"
        };
      },
    },
    pi: {
      type: "PI", label: "PI",
      convert(current, replacement, settings) {
        const validation = global.CascadeOptimisationValidation;
        if (!settings.allowPIAlternatives || validation?.isPI(current) || !validation?.isPI(replacement)
          || validation.validatePI(current, replacement).status !== "Validated") return null;
        return strategies.brand.convert(current, replacement);
      },
    },
  };

  function readHistory() {
    try {
      const records = JSON.parse(global.localStorage.getItem(HISTORY_STORAGE_KEY) || "[]");
      return Array.isArray(records) ? records : [];
    } catch (_error) {
      return [];
    }
  }

  function writeHistory(records) {
    try {
      global.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(records));
    } catch (_error) {
      // Switching remains available if storage is unavailable; the API adapter can
      // persist the same record shape when a backend is connected.
    }
  }

  async function apiRequest(path, body, user, customerId) {
    if (apiState === "offline") return null;
    let response;
    try {
      response = await global.fetch(`${API_ROOT}/${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-customer-id": customerId || "",
          ...(user ? { "x-authenticated-user": user } : {})
        },
        body: JSON.stringify(body)
      });
    } catch (_error) {
      apiState = "offline";
      return null;
    }
    if (response.status === 404 || response.status === 405) {
      apiState = "offline";
      return null;
    }
    apiState = "online";
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error?.message || "Cheaper alternatives could not complete the request.");
      error.status = response.status;
      error.code = payload.error?.code;
      throw error;
    }
    return payload.data;
  }

  function createClient(adapters) {
    const customerId = () => typeof adapters.getCustomerId === "function" ? adapters.getCustomerId() : adapters.customerId || "";
    const request = (path, body, user) => apiRequest(path, body, user, customerId());
    const required = ["getProductById", "getSelectedPrice", "getBestOffer", "getSupplierLabel"];
    required.forEach((name) => {
      if (typeof adapters[name] !== "function") throw new Error(`Brand Equalisation adapter ${name} is required.`);
    });
    const configuredExcessPercentage = Number(adapters.optimisationConfig?.maximumExcessPercentage);
    const optimisationConfig = {
      ...DEFAULT_OPTIMISATION_CONFIG,
      ...(adapters.optimisationConfig || {}),
      packOptimisationEnabled: adapters.optimisationConfig?.packOptimisationEnabled !== false,
      maximumExcessPercentage: Number.isFinite(configuredExcessPercentage) && configuredExcessPercentage >= 0
        ? configuredExcessPercentage
        : DEFAULT_OPTIMISATION_CONFIG.maximumExcessPercentage
    };

    function mappingIndex(mappingList) {
      return mappingList.reduce((index, mapping) => {
        if (!index.has(mapping.sourceProductId)) index.set(mapping.sourceProductId, []);
        index.get(mapping.sourceProductId).push(mapping);
        return index;
      }, new Map());
    }

    function isEligiblePair(current, replacement, mapping) {
      if (!current || !replacement || String(current.productId) === String(replacement.id)) return false;
      if (typeof adapters.isEligiblePair === "function"
        && !adapters.isEligiblePair(current, replacement, mapping)) return false;
      return true;
    }

    // One best commercially valid opportunity per basket line. Mappings and offers
    // are retrieved once, then each strategy performs only its own arithmetic.
    function calculateOpportunities(basket) {
      let customerRules = {};
      try {
        customerRules = JSON.parse(global.localStorage.getItem("cascade-optimisation-customer-rules-v1") || "{}")[customerId()] || {};
      } catch (_error) { /* Use configured defaults when local rules are unavailable. */ }
      const settings = { ...optimisationConfig, ...customerRules };
      const approved = approvedMappings();
      const mappings = mappingIndex(approved);
      const mappingOrder = new Map(approved.map((mapping, index) => [
        `${mapping.sourceProductId}:${mapping.replacementProductId}`,
        index
      ]));
      const opportunities = basket.flatMap((current) => {
        const currentPrice = adapters.getSelectedPrice(current);
        const currentMappings = mappings.get(String(current.productId)) || [];
        if (typeof currentPrice !== "number" || !Number.isFinite(currentPrice) || !currentMappings.length) return [];

        const candidates = currentMappings.flatMap((mapping) => {
          const replacement = adapters.getProductById(mapping.replacementProductId);
          if (!isEligiblePair(current, replacement, mapping)) return [];
          if (global.CascadeOptimisationValidation?.isPI(replacement) && mapping.mappingType !== "pi") return [];
          const strategy = strategies[mapping.mappingType];
          if (!strategy || typeof strategy.convert !== "function") return [];
          const currentProduct = mapping.mappingType === "pi"
            ? { ...adapters.getProductById(current.productId), ...current } : current;
          const conversion = strategy.convert(currentProduct, replacement, settings);
          if (!conversion) return [];
          const recommendedOffer = adapters.getBestOffer(replacement);
          if (!recommendedOffer || typeof recommendedOffer.price !== "number" || !Number.isFinite(recommendedOffer.price) || recommendedOffer.price < 0) return [];
          const drugTariffPrice = Number(replacement.tariff);
          if (!Number.isFinite(drugTariffPrice) || recommendedOffer.price > drugTariffPrice) return [];

          const currentTotalCost = currentPrice * current.quantity;
          const recommendedTotalCost = recommendedOffer.price * conversion.recommendedBasketQuantity;
          const totalSaving = currentTotalCost - recommendedTotalCost;
          if (!(money(totalSaving) > 0) || !(currentTotalCost > 0)) return [];
          const currentUnitCost = currentPrice / conversion.originalPack.comparableQuantity;
          const alternativeUnitCost = recommendedOffer.price / conversion.replacementPack.comparableQuantity;
          if (mapping.mappingType === "pack" && !(alternativeUnitCost < currentUnitCost)) return [];

          return [{
            optimisationType: strategy.type,
            optimisationTypeLabel: strategy.label,
            piReferenceProductId: mapping.mappingType === "pi" ? String(current.productId) : null,
            plpiLicenceNumber: mapping.mappingType === "pi" ? replacement.plpiLicenceNumber : null,
            lineId: current.lineId,
            mapping,
            equivalentGroupId: mapping.equivalentGroupId || "",
            currentProductId: String(current.productId),
            currentName: current.name,
            currentPip: current.pip,
            currentType: current.productType || "Product",
            currentPackSize: current.packSize || "",
            currentSupplierId: current.selectedSupplier,
            currentSupplier: adapters.getSupplierLabel(current.selectedSupplier),
            currentPrice,
            quantity: current.quantity,
            originalProductId: String(current.productId),
            originalProductName: current.name,
            originalPipCode: current.pip,
            originalPackQuantity: conversion.originalPack.comparableQuantity,
            currentPackQuantity: conversion.originalPack.comparableQuantity,
            originalBasketQuantity: current.quantity,
            currentBasketQuantity: current.quantity,
            replacementProductId: String(replacement.id),
            replacementName: replacement.name,
            replacementPip: replacement.pip,
            replacementType: mapping.mappingType === "pi" ? "PI" : replacement.productType || "Product",
            replacementPackSize: replacement.packSize || "",
            recommendedProductId: String(replacement.id),
            recommendedProductName: replacement.name,
            recommendedPipCode: replacement.pip,
            recommendedPackQuantity: conversion.replacementPack.comparableQuantity,
            alternativeProductId: String(replacement.id),
            alternativeProductName: replacement.name,
            alternativePipCode: replacement.pip,
            alternativePackQuantity: conversion.replacementPack.comparableQuantity,
            recommendedBasketQuantity: conversion.recommendedBasketQuantity,
            alternativeBasketQuantity: conversion.recommendedBasketQuantity,
            packUnit: conversion.originalPack.comparableUnit,
            comparableUnit: conversion.originalPack.comparableUnit,
            requiredComparableUnits: conversion.requiredComparableQuantity,
            requiredComparableQuantity: conversion.requiredComparableQuantity,
            requiredUnits: conversion.requiredComparableQuantity,
            alternativeSuppliedUnits: conversion.alternativeSuppliedUnits ?? conversion.requiredComparableQuantity,
            excessUnits: conversion.excessUnits ?? 0,
            excessPercentage: conversion.excessPercentage ?? 0,
            conversionType: conversion.conversionType || "EXACT",
            mappingStatus: "Validated",
            recommendedOffer: { ...recommendedOffer },
            recommendedSupplier: recommendedOffer.supplierLabel,
            recommendedPrice: recommendedOffer.price,
            currentPackPrice: currentPrice,
            alternativePackPrice: recommendedOffer.price,
            currentUnitCost,
            alternativeUnitCost,
            savingPerPack: mapping.mappingType !== "pack" ? money(currentPrice - recommendedOffer.price) : null,
            totalSaving: money(totalSaving),
            estimatedSaving: money(totalSaving),
            currentTotalCost: money(currentTotalCost),
            recommendedTotalCost: money(recommendedTotalCost),
            alternativeTotalCost: money(recommendedTotalCost)
          }];
        });

        const best = candidates.sort((a, b) => {
          const costDifference = a.recommendedTotalCost - b.recommendedTotalCost;
          if (Math.abs(costDifference) > COMPARABLE_SAVING_EPSILON) return costDifference;
          const exactDifference = Number(b.conversionType === "EXACT") - Number(a.conversionType === "EXACT");
          return exactDifference || costDifference || a.replacementProductId.localeCompare(b.replacementProductId);
        })[0];
        return best ? [best] : [];
      });
      return opportunities.sort((a, b) => {
        const aOrder = mappingOrder.get(`${a.currentProductId}:${a.replacementProductId}`) ?? Number.MAX_SAFE_INTEGER;
        const bOrder = mappingOrder.get(`${b.currentProductId}:${b.replacementProductId}`) ?? Number.MAX_SAFE_INTEGER;
        return aOrder - bOrder;
      });
    }

    function basketPayload(basket) {
      return basket.map((line) => ({
        lineId: line.lineId,
        productId: String(line.productId),
        name: line.name,
        pip: line.pip,
        productType: line.productType || "Product",
        packSize: line.packSize || "",
        packQuantity: line.packQuantity,
        packUnit: line.packUnit,
        secondaryPackQuantity: line.secondaryPackQuantity ?? line.secondaryQuantity,
        secondaryPackUnit: line.secondaryPackUnit ?? line.secondaryUnit,
        comparableQuantity: line.comparableQuantity,
        comparableUnit: line.comparableUnit,
        productFamily: line.productFamily ?? line.productFamilyId,
        quantity: line.quantity,
        currentPrice: adapters.getSelectedPrice(line),
        currentSupplierId: line.selectedSupplier || "",
        currentSupplier: adapters.getSupplierLabel(line.selectedSupplier)
      }));
    }

    function summaryFrom(opportunities) {
      return {
        hasOpportunity: opportunities.length > 0,
        hasBrandOpportunity: opportunities.length > 0,
        opportunityCount: opportunities.length,
        totalPotentialSaving: money(opportunities.reduce((sum, item) => sum + item.totalSaving, 0)),
        opportunityLineIds: opportunities.map((item) => item.lineId),
        opportunityKey: opportunityKey(opportunities)
      };
    }

    async function getSummary(basket) {
      const remote = await request("summary", { basket: basketPayload(basket) });
      if (remote) return remote;
      return summaryFrom(calculateOpportunities(basket));
    }

    async function getOpportunities(basket) {
      const remote = await request("details", { basket: basketPayload(basket) });
      if (remote) return remote;
      return calculateOpportunities(basket);
    }

    async function recordSwitch(opportunity, context = {}) {
      const line = {
        lineId: opportunity.lineId,
        productId: opportunity.currentProductId,
        name: opportunity.currentName,
        pip: opportunity.currentPip,
        productType: opportunity.currentType,
        packSize: opportunity.currentPackSize || "",
        packQuantity: opportunity.originalPackQuantity,
        packUnit: opportunity.packUnit,
        comparableQuantity: opportunity.originalPackQuantity,
        comparableUnit: opportunity.comparableUnit,
        quantity: opportunity.originalBasketQuantity ?? opportunity.quantity,
        currentPrice: opportunity.currentPrice,
        currentSupplierId: opportunity.currentSupplierId,
        currentSupplier: opportunity.currentSupplier
      };
      const remote = await request("switch", {
        line,
        replacementProductId: opportunity.replacementProductId,
        optimisationType: opportunity.optimisationType,
        context
      }, context.user);
      const record = remote ? {
        id: remote.id,
        recommendedOffer: remote.recommendedOffer,
        originalProductId: remote.currentProductId,
        originalProductName: remote.currentName,
        originalPipCode: remote.currentPip,
        originalProductType: remote.currentType,
        replacementProductId: remote.replacementProductId,
        replacementProductName: remote.replacementName,
        replacementPipCode: remote.replacementPip,
        replacementProductType: remote.replacementType,
        optimisationType: remote.optimisationType,
        optimisationTypeLabel: remote.optimisationTypeLabel,
        originalPackQuantity: remote.originalPackQuantity,
        finalPackQuantity: remote.recommendedPackQuantity,
        originalBasketQuantity: remote.originalBasketQuantity,
        finalBasketQuantity: remote.recommendedBasketQuantity,
        comparableUnit: remote.comparableUnit,
        requiredComparableQuantity: remote.requiredComparableQuantity,
        alternativeSuppliedUnits: remote.alternativeSuppliedUnits,
        excessUnits: remote.excessUnits,
        excessPercentage: remote.excessPercentage,
        conversionType: remote.conversionType,
        originalUnitCost: remote.currentUnitCost,
        replacementUnitCost: remote.alternativeUnitCost,
        originalTotalCost: remote.currentTotalCost,
        recommendedTotalCost: remote.recommendedTotalCost,
        originalSupplier: remote.currentSupplier,
        replacementSupplier: remote.recommendedSupplier,
        originalPrice: money(remote.currentPrice),
        replacementPrice: money(remote.recommendedPrice),
        quantity: remote.originalBasketQuantity ?? remote.quantity,
        estimatedSaving: money(remote.totalSaving),
        user: remote.user,
        customer: remote.customer,
        dateTime: remote.dateTime,
        orderReference: remote.orderReference,
        orderId: remote.orderId || remote.orderReference,
        customerId: remote.customerId || context.customerId || remote.customer,
        switchSource: remote.switchSource || context.switchSource || "Individual",
        action: remote.action || "Equalised"
      } : {
        id: global.crypto?.randomUUID?.() || `brand-switch-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        originalProductId: opportunity.currentProductId,
        originalProductName: opportunity.currentName,
        originalPipCode: opportunity.currentPip,
        originalProductType: opportunity.currentType,
        replacementProductId: opportunity.replacementProductId,
        replacementProductName: opportunity.replacementName,
        replacementPipCode: opportunity.replacementPip,
        replacementProductType: opportunity.replacementType,
        optimisationType: opportunity.optimisationType,
        optimisationTypeLabel: opportunity.optimisationTypeLabel,
        originalPackQuantity: opportunity.originalPackQuantity,
        finalPackQuantity: opportunity.recommendedPackQuantity,
        originalBasketQuantity: opportunity.originalBasketQuantity,
        finalBasketQuantity: opportunity.recommendedBasketQuantity,
        comparableUnit: opportunity.comparableUnit,
        requiredComparableQuantity: opportunity.requiredComparableQuantity,
        alternativeSuppliedUnits: opportunity.alternativeSuppliedUnits,
        excessUnits: opportunity.excessUnits,
        excessPercentage: opportunity.excessPercentage,
        conversionType: opportunity.conversionType,
        originalUnitCost: opportunity.currentUnitCost,
        replacementUnitCost: opportunity.alternativeUnitCost,
        originalTotalCost: opportunity.currentTotalCost,
        recommendedTotalCost: opportunity.recommendedTotalCost,
        originalSupplier: opportunity.currentSupplier,
        replacementSupplier: opportunity.recommendedSupplier,
        originalPrice: money(opportunity.currentPrice),
        replacementPrice: money(opportunity.recommendedPrice),
        quantity: opportunity.quantity,
        estimatedSaving: money(opportunity.totalSaving),
        user: context.user || "Unknown user",
        customer: context.customer || "Unknown customer",
        dateTime: new Date().toISOString(),
        orderReference: context.orderReference || null,
        orderId: context.orderId || context.orderReference || null,
        customerId: context.customerId || context.customer || "Unknown customer",
        switchSource: context.switchSource || "Individual",
        action: "Equalised"
      };
      record.piReferenceProductId = remote?.piReferenceProductId ?? opportunity.piReferenceProductId;
      record.plpiLicenceNumber = remote?.plpiLicenceNumber ?? opportunity.plpiLicenceNumber;
      const history = readHistory();
      history.unshift(record);
      writeHistory(history.slice(0, 500));
      return record;
    }

    // Undo is its own audit action; the original switch record is never changed.
    async function recordUndo(equalisation, context = {}) {
      const remote = await request("undo", {
        switchId: equalisation.auditId,
        context
      }, context.user);
      const record = remote ? {
        ...remote,
        originalProductId: equalisation.originalProductId,
        originalProductName: equalisation.originalName,
        originalPipCode: equalisation.originalPip,
        replacementProductId: equalisation.replacementProductId,
        replacementProductName: equalisation.replacementName,
        replacementPipCode: equalisation.replacementPip,
        estimatedSaving: equalisation.estimatedSaving
      } : {
        id: global.crypto?.randomUUID?.() || `brand-undo-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        action: "Undo",
        parentSwitchId: equalisation.auditId,
        undoBy: context.user || "Unknown user",
        undoAt: new Date().toISOString(),
        orderId: context.orderId || context.orderReference || null,
        customerId: context.customerId || context.customer || "Unknown customer",
        originalProductId: equalisation.originalProductId,
        originalProductName: equalisation.originalName,
        originalPipCode: equalisation.originalPip,
        replacementProductId: equalisation.replacementProductId,
        replacementProductName: equalisation.replacementName,
        replacementPipCode: equalisation.replacementPip,
        estimatedSaving: equalisation.estimatedSaving
      };
      const history = readHistory();
      history.unshift(record);
      writeHistory(history.slice(0, 500));
      return record;
    }

    return {
      getSummary,
      getOpportunities,
      recordSwitch,
      recordUndo,
      getHistory: readHistory
    };
  }

  // Changes when a line, replacement, quantity or saving changes (used to reset a dismissed banner).
  function opportunityKey(opportunities) {
    return opportunities
      .map((item) => `${item.lineId}:${item.optimisationType}:${item.replacementProductId}:${item.recommendedBasketQuantity ?? item.quantity}:${item.totalSaving}`)
      .join("|");
  }

  const publicApi = {
    createClient,
    getApprovedMappings: approvedMappings,
    getHistory: readHistory,
    opportunityKey,
    money,
    configuration: DEFAULT_OPTIMISATION_CONFIG,
    storageKeys: { admin: ADMIN_STORAGE_KEY, history: HISTORY_STORAGE_KEY }
  };
  global.CascadeOptimisation = publicApi;
  global.CascadeBrandEqualisation = publicApi;
})(window);
