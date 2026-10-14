const featureFlags = new Set(window.name.split(",").filter(Boolean));
featureFlags.add("codePlan");
window.name = Array.from(featureFlags).join(",");
