import { z } from "zod";

import { lerEnvelope, type LeituraDeEnvelope } from "@/lib/webhooks/contrato";

const text = z.string().min(1);
const instanceData = z.looseObject({
  token: z.string().optional(),
  baseUrl: z.string().optional(),
});

const message = z.looseObject({
  id: text.optional(),
  direction: z.enum(["incoming", "outgoing"]),
  status: z.string().optional(),
  text: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  timestamp: z.union([z.string(), z.number()]).optional(),
  remoteJid: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  media: z.unknown().optional(),
});

const data = z.looseObject({
  id: text.optional(),
  message,
  instanceData: instanceData.optional(),
});

export const ryzeEnvelopeSchema = z.looseObject({
  event: z.enum(["message.exchange", "message.status"]),
  data,
});

export type RyzeEnvelope = z.infer<typeof ryzeEnvelopeSchema>;
export type RyzeMessage = RyzeEnvelope["data"]["message"];

export function lerEnvelopeRyze(rawBody: string): LeituraDeEnvelope<RyzeEnvelope> {
  return lerEnvelope(rawBody, ryzeEnvelopeSchema);
}

export function ryzeExternalId(envelope: RyzeEnvelope): string | null {
  return envelope.data.message.id ?? envelope.data.id ?? null;
}
