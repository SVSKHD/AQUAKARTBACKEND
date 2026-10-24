// Product forms may submit populated taxonomy documents from a GET response.
// Persist and validate the referenced ID rather than stringifying the document.
export const cleanProductReference = (value) => {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value === "object" && value._id !== undefined) {
    value = value._id;
  }
  return String(value).trim();
};
