---
description: 'Choose how your Platform installation pays Cloudflare and AI providers for the AI its apps use.'
---

# Paying for AI

Apps on your Platform call AI models through one Cloudflare AI Gateway that the installer creates in your Cloudflare account. You choose how that gateway pays for model use. The choice lives in Cloudflare, not in Platform, and you can change it at any time without a deploy.

## Find your gateway

The gateway is named after your installation: `platform-` followed by the installation name. In the Cloudflare dashboard, go to **AI** > **AI Gateway** to find it. The settings below are on that gateway.

## Choose how to pay for third-party models

Calls to models from providers such as Anthropic, OpenAI and Google go through the gateway. The gateway looks for a provider key in this order:

1. A provider key on the request. Platform only sends one for [provider-native requests](/guide/ai#provider-native-requests), which use the app's own key.
2. A key stored on the gateway for that provider, with the alias `default`.
3. Unified billing, which uses Cloudflare's own provider accounts and your prepaid Cloudflare credits.

### Unified billing

This works with no setup beyond buying credits. Load credits in the Cloudflare dashboard, and Cloudflare charges the provider's price for each request with no markup. Cloudflare adds a 5% fee when you buy credits: $100 of credits costs $105. When the credits run out, AI calls fail with HTTP `402` until you add more. Turn on auto top-up to avoid that.

### Your own provider key

To pay a provider directly, with no fee from Cloudflare, store your key on the gateway:

1. Open the gateway and go to **Provider Keys**.
2. Select **Add API Key**, choose the provider and paste your key.
3. Keep the alias `default`. Calls from apps only look for a key with that alias.

The provider then bills you directly for that provider's models. Other providers keep using unified billing. If the stored key fails, for example because your provider account is out of funds, the call fails. It doesn't fall back to your credits. To stop all fallback to credits, turn on **Require provider credentials** in the gateway's settings. Calls to a provider with no stored key then fail with HTTP `400`.

Check your provider account's spend limits before your apps go live. A provider can cap a new account's monthly spend and answer HTTP `429` at the cap.

## Choose how to pay for Workers AI

Workers AI models (the `@cf/` models) don't use provider keys. The gateway's **Workers AI Billing** setting decides how they're paid for:

- **Standard billing** is the default. Workers AI use goes on your monthly Cloudflare bill.
- **Unified billing** takes Workers AI use from your prepaid credits, so the 5% fee on credits applies. Cloudflare gives some frontier Workers AI models a higher rate limit on credits: 50 requests a minute for each model, against 20 on Standard billing.

## What Platform counts

Platform counts each hosted project's AI from the gateway: it tags each call with the project and reads the cost figure that the gateway reports for that project. That figure is Cloudflare's estimate from the tokens sent and received. Your provider's bill is the exact amount.

Calls an app makes with its own provider key, through [provider-native requests](/guide/ai#provider-native-requests), carry no project tag. Platform doesn't count them, and the provider bills the app's owner.

What a connected app's people pay for AI comes from the AI meter prices, `aiNeurons` and `hostedAiNeurons`, under **Admin → Connected apps → Usage prices**. The default, $0.000011 a neuron, is the provider's list price with no markup. To charge list price plus 10%, set both to `0.0000121`. If you pay through unified billing, the 5% fee on credits isn't in the gateway's cost figure, so raise the prices to cover it. See [Charge for use](./connected-apps.md#charge-for-use).
