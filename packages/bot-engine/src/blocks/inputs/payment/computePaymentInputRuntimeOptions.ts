import { TRPCError } from "@trpc/server";
import { defaultPaymentInputOptions } from "@typebot.io/blocks-inputs/payment/constants";
import type {
  PaymentInputBlock,
  PaymentInputRuntimeOptions,
} from "@typebot.io/blocks-inputs/payment/schema";
import type { SessionState } from "@typebot.io/chat-session/schemas";
import { decrypt } from "@typebot.io/credentials/decrypt";
import { getCredentials } from "@typebot.io/credentials/getCredentials";
import type { StripeCredentials } from "@typebot.io/credentials/schemas";
import type { SessionStore } from "@typebot.io/runtime-session-store";
import { parseVariables } from "@typebot.io/variables/parseVariables";
import Stripe from "stripe";

export const computePaymentInputRuntimeOptions = (
  options: PaymentInputBlock["options"],
  { sessionStore, state }: { sessionStore: SessionStore; state: SessionState },
) => createStripePaymentIntent(options, { sessionStore, state });

const createStripePaymentIntent = async (
  options: PaymentInputBlock["options"],
  { sessionStore, state }: { sessionStore: SessionStore; state: SessionState },
): Promise<PaymentInputRuntimeOptions> => {
  const {
    resultId,
    typebot: { variables },
  } = state.typebotsQueue[0];
  const isPreview = !resultId;
  if (!options?.credentialsId)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Missing credentialsId",
    });
  const stripeKeys = await getStripeInfo(
    options.credentialsId,
    state.workspaceId,
  );
  if (!stripeKeys)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Credentials not found",
    });
  const stripe = new Stripe(
    isPreview && stripeKeys?.test?.secretKey
      ? stripeKeys.test.secretKey
      : stripeKeys.live.secretKey,
    { apiVersion: "2024-09-30.acacia" },
  );
  const currency = options?.currency ?? defaultPaymentInputOptions.currency;
  const amount = Math.round(
    Number(parseVariables(options.amount, { variables, sessionStore })) *
      (isZeroDecimalCurrency(currency) ? 1 : 100),
  );
  if (isNaN(amount))
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Could not parse amount, make sure your block is configured correctly",
    });
  // Create a PaymentIntent with the order amount and currency
  const receiptEmail = parseVariables(options.additionalInformation?.email, {
    variables,
    sessionStore,
  });
  const paymentIntent = await stripe.paymentIntents.create({
    amount,
    currency,
    receipt_email: receiptEmail === "" ? undefined : receiptEmail,
    description: parseVariables(options.additionalInformation?.description, {
      variables,
      sessionStore,
    }),
    automatic_payment_methods: {
      enabled: true,
    },
  });

  if (!paymentIntent.client_secret)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Could not create payment intent",
    });

  const priceFormatter = new Intl.NumberFormat(
    options.currency === "EUR" ? "fr-FR" : undefined,
    {
      style: "currency",
      currency,
    },
  );

  return {
    paymentIntentSecret: paymentIntent.client_secret,
    publicKey:
      isPreview && stripeKeys.test?.publicKey
        ? stripeKeys.test.publicKey
        : stripeKeys.live.publicKey,
    amountLabel: priceFormatter.format(
      amount / (isZeroDecimalCurrency(currency) ? 1 : 100),
    ),
  };
};

const getStripeInfo = async (
  credentialsId: string,
  workspaceId: string,
): Promise<StripeCredentials["data"] | undefined> => {
  const credentials = await getCredentials(credentialsId, workspaceId);
  if (!credentials) return;
  return (await decrypt(
    credentials.data,
    credentials.iv,
  )) as StripeCredentials["data"];
};

// https://stripe.com/docs/currencies#zero-decimal
const isZeroDecimalCurrency = (currency: string) =>
  [
    "BIF",
    "CLP",
    "DJF",
    "GNF",
    "JPY",
    "KMF",
    "KRW",
    "MGA",
    "PYG",
    "RWF",
    "UGX",
    "VND",
    "VUV",
    "XAF",
    "XOF",
    "XPF",
  ].includes(currency);
