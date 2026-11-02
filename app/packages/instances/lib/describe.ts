import { msg } from "gt-react";
import { isGpuType, specs } from "./attributes";
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
  const gpus = Number(a.gpu ?? a.GPUAmount);
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
