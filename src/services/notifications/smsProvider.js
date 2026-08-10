// SMS is intentionally not active yet. This contract keeps callers provider-ready
// without sending or exposing an unfinished public endpoint.
export const getSmsStatus = () => ({
  available: false,
  configured: false,
  mode: "placeholder",
  provider: "fast2sms",
});

export const sendSms = async () => {
  const error = new Error("SMS delivery is not enabled yet");
  error.code = "SMS_NOT_ENABLED";
  error.statusCode = 503;
  throw error;
};
