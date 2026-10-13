/** Messages whose body is still an envelope. Newest first, so the open card fills before older ones. */
export function bodiesToFill(messages = []) {
  if (!Array.isArray(messages)) return [];
  return messages.filter((message) => message && message.sourceImported === false && message.id).reverse();
}
