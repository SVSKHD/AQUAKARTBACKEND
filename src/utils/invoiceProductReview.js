export const normalizeReviewProductText = (value = "") =>
  String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const titleMatch = (left, right) => {
  if (!left || !right) return false;
  if (left === right) return true;
  const leftTokens = new Set(left.split(" ").filter(Boolean));
  const rightTokens = new Set(right.split(" ").filter(Boolean));
  const leftModels = [...leftTokens].filter((token) => /\d/.test(token));
  const rightModels = [...rightTokens].filter((token) => /\d/.test(token));
  if (
    leftModels.some((token) => !rightTokens.has(token)) ||
    rightModels.some((token) => !leftTokens.has(token))
  ) {
    return false;
  }
  const shared = [...leftTokens].filter((token) =>
    rightTokens.has(token),
  ).length;
  const smallest = Math.min(leftTokens.size, rightTokens.size);
  return smallest >= 2 && shared / smallest >= 0.8;
};

export const invoiceContainsProduct = ({ invoice, product }) => {
  const productId = String(product?._id || "");
  const productSlug = String(product?.slug || "")
    .trim()
    .toLowerCase();
  const productTitle = normalizeReviewProductText(product?.title);

  return (invoice?.products || []).some((line) => {
    const lineProductId = String(line?.productId || "");
    const lineSlug = String(line?.productSlug || "")
      .trim()
      .toLowerCase();
    const lineName = normalizeReviewProductText(line?.productName);
    return (
      (lineProductId && lineProductId === productId) ||
      (lineSlug && productSlug && lineSlug === productSlug) ||
      titleMatch(lineName, productTitle)
    );
  });
};
