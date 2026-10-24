import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appFile = fileURLToPath(new URL("../../app.js", import.meta.url));
const methods = "get|post|put|patch|delete|head|options";
const labels = {
  product: "Products",
  category: "Categories",
  "sub-category": "Subcategories",
  subCategory: "Subcategories",
  user: "Auth",
  googleAuth: "Auth",
  invoice: "Invoices",
  publicInvoice: "Invoices / Public",
  invoiceReports: "Invoices / Reports",
  quotation: "Quotations",
  adminUser: "Users",
  customer: "Customers",
  customerProfile: "Customer Profiles",
  order: "Orders",
  coupon: "Coupons",
  lead: "Leads",
  activity: "Activities",
  deal: "Deals",
  stock: "Stock",
  ai: "AI",
  seo: "SEO",
  phonepegatway: "PhonePe Gateway",
};
const humanize = (name) =>
  labels[name] ||
  name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
const normalize = (value) =>
  ("/" + value.split("/").filter(Boolean).join("/")).replace(
    /:([A-Za-z0-9_]+)/g,
    "{$1}",
  );

// Read route source only: importing routers would execute application code.
// Follows local default imports mounted with router.use/app.use, including
// nested folders. New literal router.METHOD routes inherit their file's group.
export const discoverRouteGroups = async (entryFile = appFile) => {
  const routesRoot = path.join(path.dirname(entryFile), "src", "routes");
  const groups = new Map();
  const visit = async (filename, prefix, ancestors = new Set()) => {
    if (ancestors.has(filename)) return;
    const nextAncestors = new Set([...ancestors, filename]);
    const source = (await fs.readFile(filename, "utf8"))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const imports = new Map();
    for (const match of source.matchAll(
      /import\s+(\w+)\s+from\s+["'](\.[^"']+)["']/g,
    )) {
      imports.set(match[1], path.resolve(path.dirname(filename), match[2]));
    }
    const relative = path.relative(routesRoot, filename).replaceAll("\\", "/");
    const parts = relative.replace(/\.js$/, "").split("/");
    const group =
      filename === entryFile
        ? "General"
        : parts
            .map((part) =>
              part.toLowerCase() === "crm" ? "CRM" : humanize(part),
            )
            .join(" / ");
    const routePattern = new RegExp(
      `\\b(?:app|router)\\.(${methods})\\(\\s*["']([^"']*)["']`,
      "g",
    );
    for (const match of source.matchAll(routePattern)) {
      const routePath = normalize(`${prefix}/${match[2]}`);
      const auth =
        parts.at(-1) === "adminUser" && /\/(login|signup)$/.test(routePath);
      groups.set(`${match[1]} ${routePath}`, auth ? "CRM / Auth" : group);
    }
    for (const match of source.matchAll(
      /\b(?:app|router)\.use\(\s*["']([^"']*)["']\s*,\s*(\w+)\s*\)/g,
    )) {
      const target = imports.get(match[2]);
      if (target && target.startsWith(routesRoot + path.sep)) {
        await visit(target, normalize(`${prefix}/${match[1]}`), nextAncestors);
      }
    }
  };
  await visit(path.resolve(entryFile), "");
  return groups;
};

export const applyRouteGroups = async (document, entryFile = appFile) => {
  const groups = await discoverRouteGroups(entryFile);
  const used = new Set();
  for (const [routePath, item] of Object.entries(document.paths || {})) {
    for (const [method, operation] of Object.entries(item)) {
      if (!methods.split("|").includes(method)) continue;
      const group =
        groups.get(`${method} ${normalize(routePath)}`) ||
        operation.tags?.[0] ||
        "General";
      operation.tags = [group];
      used.add(group);
    }
  }
  const existing = new Map((document.tags || []).map((tag) => [tag.name, tag]));
  document.tags = [...used]
    .sort((a, b) => a.localeCompare(b))
    .map(
      (name) =>
        existing.get(name) || { name, description: `${name} endpoints` },
    );
  return document;
};
