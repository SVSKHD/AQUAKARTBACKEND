import AquaProduct from "../models/product.js";

const BASE_URL = "https://aquakart.co.in";

const escapeXml = (value = "") =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const stripHtml = (value = "") =>
  String(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const productSlug = (product) =>
  product.slug || product.seoSlug || product.ShortName || product.code || product._id;

const productPrice = (product) =>
  product.discountPriceStatus && Number(product.discountPrice) > 0
    ? Number(product.discountPrice)
    : Number(product.price || 0);

const firstImage = (product) =>
  Array.isArray(product.photos) && product.photos.length
    ? product.photos[0]?.secure_url || ""
    : "";

const merchantItem = (product) => {
  const slug = productSlug(product);
  const link = `${BASE_URL}/product/${encodeURIComponent(slug)}`;
  const availability = Number(product.stock || 0) > 0 ? "in_stock" : "out_of_stock";
  const identifierExists =
    product.identifierExists !== false && Boolean(product.gtin || product.mpn || product.brand);

  const optional = [];
  if (product.gtin) optional.push(`<g:gtin>${escapeXml(product.gtin)}</g:gtin>`);
  if (product.mpn) optional.push(`<g:mpn>${escapeXml(product.mpn)}</g:mpn>`);
  if (product.googleProductCategory) {
    optional.push(
      `<g:google_product_category>${escapeXml(product.googleProductCategory)}</g:google_product_category>`,
    );
  }
  if (product.productType) {
    optional.push(`<g:product_type>${escapeXml(product.productType)}</g:product_type>`);
  }
  if (product.shippingWeight) {
    optional.push(`<g:shipping_weight>${escapeXml(product.shippingWeight)}</g:shipping_weight>`);
  }

  return `
    <item>
      <g:id>${escapeXml(product._id)}</g:id>
      <title>${escapeXml(product.title)}</title>
      <description>${escapeXml(stripHtml(product.description).slice(0, 5000))}</description>
      <link>${escapeXml(link)}</link>
      <g:image_link>${escapeXml(firstImage(product))}</g:image_link>
      <g:availability>${availability}</g:availability>
      <g:price>${productPrice(product).toFixed(2)} INR</g:price>
      <g:condition>${escapeXml(product.condition || "new")}</g:condition>
      <g:brand>${escapeXml(product.brand || "Aquakart")}</g:brand>
      <g:identifier_exists>${identifierExists ? "yes" : "no"}</g:identifier_exists>
      ${optional.join("\n      ")}
    </item>`;
};

export const getGoogleMerchantFeed = async (_req, res) => {
  try {
    const products = await AquaProduct.find({
      merchantEnabled: { $ne: false },
      title: { $exists: true, $ne: "" },
      price: { $exists: true },
      photos: { $exists: true, $ne: [] },
    })
      .sort({ createdAt: -1 })
      .lean();

    const items = products
      .filter((product) => firstImage(product) && productPrice(product) > 0)
      .map(merchantItem)
      .join("\n");

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>Aquakart Products</title>
    <link>${BASE_URL}</link>
    <description>Aquakart product feed for Google Merchant Center</description>
${items}
  </channel>
</rss>`;

    res.set("Content-Type", "application/xml; charset=utf-8");
    res.set("Cache-Control", "public, max-age=900, stale-while-revalidate=3600");
    return res.status(200).send(xml);
  } catch (error) {
    console.error("Unable to build Google Merchant feed:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to build Google Merchant feed",
    });
  }
};

export default { getGoogleMerchantFeed };
