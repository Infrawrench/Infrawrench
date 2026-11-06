import { msg } from "gt-react";
import { gpuCount, isGpuType, specs } from "./attributes";
import { formatMoney } from "./format";
import type { Translate } from "./i18n/server";
import { latestAttributes, type InstanceModel } from "./model";
import { CLOUDS, cloudOf, fullLabel } from "./platforms";

/**
 * One or two sentences about the instance, for the page and its meta
 * description. Whole sentences are translation sources, with the specs as a
 * locale-joined list, so word order is the translator's to choose.
 */
export function describe(m: InstanceModel, tr: Translate, locale: string): string {
  const a = latestAttributes(m.attributes);
  const { vcpu, memory } = specs(a);
  const gpuType = isGpuType(a);
  const parts: string[] = [];
  if (vcpu && Number(vcpu) > 0) {
    parts.push(tr(msg("{count, plural, one {# vCPU} other {# vCPUs}}"), { count: Number(vcpu) }));
  }
  if (memory) parts.push(tr(msg("{memory} of memory"), { memory }));
  const gpus = gpuCount(a);
  if (gpus > 0) parts.push(tr(msg("{count, plural, one {# GPU} other {# GPUs}}"), { count: gpus }));
  // A RunPod GPU type's own memory; Alibaba gives each GPU's, so it is multiplied out.
  const gpuMemory = gpuType
    ? a.memoryInGb && `${a.memoryInGb} GB`
    : gpus > 0 && Number(a.GPUMemorySize) > 0 && `${gpus * Number(a.GPUMemorySize)} GiB`;
  if (gpuMemory) parts.push(tr(msg("{memory} of GPU memory"), { memory: gpuMemory }));

  const provider = CLOUDS[cloudOf(m.platform)].label;
  const platform = fullLabel(m.platform);
  const specList = new Intl.ListFormat(locale, { type: "conjunction" }).format(parts);
  const sentences = [
    gpuType
      ? parts.length > 0
        ? tr(msg("{name} is a GPU on {provider}, with {specs}."), {
            name: m.name,
            provider,
            specs: specList,
          })
        : tr(msg("{name} is a GPU on {provider}."), { name: m.name, provider })
      : parts.length > 0
        ? tr(msg("{name} is an instance type on {platform} with {specs}."), {
            name: m.name,
            platform,
            specs: specList,
          })
        : tr(msg("{name} is an instance type on {platform}."), { name: m.name, platform }),
  ];

  const region = m.regions[m.defaultRegion];
  const price = m.current[m.defaultRegion]?.find(([v]) => v === m.defaultVariant)?.[1];
  if (m.deletedAt !== null) sentences.push(tr(msg("{provider} no longer lists it."), { provider }));
  else if (region && price !== undefined) {
    const formatted = formatMoney(price, undefined, locale);
    sentences.push(
      gpuType
        ? tr(msg("It costs {price} per GPU per hour on demand."), { price: formatted })
        : m.regions.length <= 1
          ? tr(msg("It costs {price} per hour on demand."), { price: formatted })
          : tr(msg("It costs {price} per hour on demand in {region}."), {
              price: formatted,
              region: region.name,
            }),
    );
  }
  // Chinese and Japanese run sentences together after their full stop.
  return sentences.join(/^(ja|zh)\b/.test(locale) ? "" : " ");
}

/**
 * The page title: provider, name and the headline specs, the way people search
 * for an instance ("aws m5.large"). "AWS m5.large: 2 vCPUs, 8 GiB, price by
 * region". Without specs (a RunPod GPU type), "AWS m5.large pricing and specs".
 */
export function instanceTitle(m: InstanceModel, tr: Translate, locale: string): string {
  const a = latestAttributes(m.attributes);
  const { vcpu, memory } = specs(a);
  const parts: string[] = [];
  if (vcpu && Number(vcpu) > 0) {
    parts.push(tr(msg("{count, plural, one {# vCPU} other {# vCPUs}}"), { count: Number(vcpu) }));
  }
  if (memory) parts.push(memory);
  const gpus = gpuCount(a);
  if (gpus > 0) parts.push(tr(msg("{count, plural, one {# GPU} other {# GPUs}}"), { count: gpus }));
  const provider = CLOUDS[cloudOf(m.platform)].label;
  if (parts.length === 0) {
    return tr(msg("{provider} {name} pricing and specs"), { provider, name: m.name });
  }
  // A short list, not a sentence: "and" would read oddly in a title.
  const specList = parts.join(/^(ja|zh)\b/.test(locale) ? "、" : locale === "ar" ? "، " : ", ");
  return tr(msg("{provider} {name}: {specs}, price by region"), {
    provider,
    name: m.name,
    specs: specList,
  });
}
