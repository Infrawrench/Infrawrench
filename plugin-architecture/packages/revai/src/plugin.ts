import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { RevAiClient } from "./client.js";
import { AccountResourceType } from "./resources/account.js";
import { JobResourceType } from "./resources/job.js";
import { VocabularyResourceType } from "./resources/vocabulary.js";
import { REVAI_REGION_FIELDS } from "./options.js";

// Mark extracted from Rev AI's own logotype SVG, the one their site loads as
// 69710fc5182cc91d6778a91f_rev-ai-logo.svg — the icon is the leading glyph of
// that 120×28 artwork (its own bbox is x 0–22.35, y 5–28), lifted out and
// centred on the 100×100 plugin card. The container colour is sampled from
// their apple-touch-icon (webclip_rev.ai.png), a near-black indigo.
const manifest: PluginManifest = {
  id: "revai",
  version: "0.1.0",
  displayName: "Rev AI",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="20" fill="#171235"/>
    <g transform="translate(22.8,9.83) scale(2.435)">
      <path fill="#fff" d="M12.7032 16.5236H15.3544C15.3381 15.7062 15.0895 14.9111 14.6387 14.235C14.301 13.7299 13.8573 13.3077 13.3399 12.999C12.8226 12.6902 12.2443 12.5026 11.647 12.4497C11.0498 12.3968 10.4485 12.4799 9.8866 12.6931C9.32476 12.9062 8.81636 13.2441 8.3983 13.6822C7.8375 14.266 7.45999 15.0069 7.31394 15.8105C7.16088 16.6145 7.24386 17.4467 7.55249 18.2029C7.86106 18.9591 8.3816 19.6056 9.04891 20.0616C9.71547 20.5136 10.4984 20.7541 11.2989 20.7526H21.6435C21.4351 21.2845 21.1887 21.8 20.9062 22.295H11.2881C10.3198 22.3014 9.3665 22.0513 8.5215 21.5692C7.67651 21.087 6.96889 20.3892 6.46792 19.5443C5.96695 18.6995 5.68983 17.7363 5.66369 16.7494C5.63756 15.7624 5.86332 14.7855 6.31886 13.9143C6.77439 13.0431 7.44407 12.3074 8.26228 11.7795C9.08051 11.2515 10.0192 10.9493 10.9864 10.9024C11.9537 10.8557 12.9162 11.0658 13.7798 11.5124C14.6434 11.959 15.3783 12.6266 15.9128 13.4499C16.5207 14.3884 16.8467 15.4874 16.8508 16.612H19.4966C19.5071 14.9517 19.0324 13.3258 18.133 11.9417C17.2337 10.5576 15.9504 9.47785 14.4468 8.84036C12.9432 8.20279 11.2875 8.03631 9.6908 8.36202C8.09405 8.68772 6.62864 9.49102 5.4814 10.6693C4.32042 11.8417 3.52743 13.3394 3.2032 14.9724C2.87898 16.6053 3.03815 18.2996 3.66049 19.8401C4.28284 21.3806 5.34025 22.6976 6.69839 23.6239C8.05656 24.5503 9.65405 25.044 11.2881 25.0424H18.77C17.3483 26.3665 15.6157 27.2942 13.7396 27.736C11.8635 28.1779 9.90732 28.1189 8.06006 27.5648C6.21284 27.0107 4.53699 25.9802 3.19442 24.5729C1.85185 23.1656 0.88794 21.429 0.395822 19.5309C-0.289353 16.9885 -0.0972034 14.2833 0.940106 11.868C1.97741 9.45281 3.79693 7.47416 6.09405 6.26338C8.38347 5.06257 11.009 4.70382 13.5277 5.24765C16.0464 5.79149 18.304 7.20462 19.9194 9.24856C20.8811 10.4639 21.5903 11.8658 22.0041 13.3692C22.4179 14.8726 22.5277 16.4461 22.3267 17.9941H11.2935C11.0162 17.9936 10.7449 17.9111 10.5128 17.7564C10.273 17.6029 10.084 17.3795 9.9706 17.1151C9.86133 16.855 9.82943 16.568 9.87892 16.2896C9.92841 16.0112 10.0571 15.7539 10.2488 15.5494C10.4407 15.345 10.6872 15.2026 10.9577 15.1399C11.2283 15.0772 11.511 15.097 11.7706 15.1968C12.0283 15.2983 12.2522 15.4729 12.4158 15.6999C12.5928 15.9375 12.6932 16.2253 12.7032 16.5236Z"/>
    </g>
  </svg>`,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "accessToken",
      label: "Access Token",
      description:
        "Your Rev AI access token, sent as `Authorization: Bearer <token>`. Generate it in the Rev AI dashboard at rev.ai under Access Token — it is shown once, and regenerating it invalidates the old one. One token covers jobs, transcripts, custom vocabularies and the account balance; there is no separate admin key.",
      sensitive: true,
      placeholder: "02abcDEFghIJklMNopQRstUVwxYZ0123456789abcdefghij",
      helpLink: { label: "Open the Rev AI dashboard", url: "https://www.rev.ai/access-token" },
    },
    {
      key: "region",
      label: "Deployment",
      description:
        "Which Rev AI deployment this token belongs to. Jobs are not portable between deployments — a job submitted to the US host is invisible from the EU host and vice versa. The EU deployment (Frankfurt) does not offer human transcription or the saved custom-vocabulary collection.",
      sensitive: false,
      regions: REVAI_REGION_FIELDS,
      defaultValue: "us",
    },
    caCertCredentialField,
  ],
};

const resourceTypes: ResourceTypeDefinition[] = [
  AccountResourceType,
  JobResourceType,
  VocabularyResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new RevAiClient(credentials, services),
};
