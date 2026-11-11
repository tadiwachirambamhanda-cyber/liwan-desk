// The phone page's own routes (read a chat, answer as the receptionist, hand back) are only
// open in development, or on a deployment where SIMULATOR_ENABLED=true was set on purpose.
// Never turn that switch on for a deployment that holds real patient data. The staff inbox
// (step 3 of 4) is what gives real staff access.

export function simulatorRoutesAreOpen(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.SIMULATOR_ENABLED === "true";
}

export function closedResponse(): Response {
  return Response.json({ error: "Not available here" }, { status: 404 });
}

export function unavailableResponse(): Response {
  return Response.json({ error: "The conversation memory could not be reached" }, { status: 503 });
}
