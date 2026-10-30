import { msg } from "gt-react";
import { specs } from "./attributes";
import { formatMoney } from "./format";
import type { Translate } from "./i18n/server";
import { latestAttributes, type InstanceModel } from "./model";

/**
 * One or two sentences about the instance, for the page and its meta
 * description. Whole sentences are translation sources, with the specs as a
 * locale-joined list, so word order is the translator's to choose.
 */
export function describe(m: InstanceModel, tr: Translate, locale: string): string {
  const a = latestAttributes(m.attributes);
  const { vcpu, memory } = specs(a);
  const parts: string[] = [];
  if (vcpu && Number(vcpu) > 0) {
    parts.push(tr(msg("{count, plural, one {# vCPU} other {# vCPUs}}"), { count: Number(vcpu) }));
  }
  if (memory) parts.push(tr(msg("{memory} of memory"), { memory }));
  const gpus = Number(a.gpu);
  if (gpus > 0) parts.push(tr(msg("{count, plural, one {# GPU} other {# GPUs}}"), { count: gpus }));

  const specList = new Intl.ListFormat(locale, { type: "conjunction" }).format(parts);
  const sentences = [
    parts.length > 0
      ? tr(msg("{name} is an AWS {platform} instance with {specs}."), {
          name: m.name,
          platform: m.platformLabel,
          specs: specList,
        })
      : tr(msg("{name} is an AWS {platform} instance."), {
          name: m.name,
          platform: m.platformLabel,
        }),
  ];

  const region = m.regions[m.defaultRegion];
  const price = m.current[m.defaultRegion]?.find(([v]) => v === m.defaultVariant)?.[1];
  if (m.deletedAt !== null) sentences.push(tr(msg("AWS no longer lists it.")));
  else if (region && price !== undefined) {
    sentences.push(
      tr(msg("It costs {price} per hour on demand in {region}."), {
        price: formatMoney(price, undefined, locale),
        region: region.name,
      }),
    );
  }
  // Chinese and Japanese run sentences together after their full stop.
  return sentences.join(/^(ja|zh)\b/.test(locale) ? "" : " ");
}
