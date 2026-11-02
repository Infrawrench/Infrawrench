/**
 * Names for the locations a bundle gives by code alone. Google Cloud's bundle
 * lists each region by its id (`us-central1`) with no name, so the warehouse's
 * `regions` table and instances.infrawrench.com's region picker take the
 * location Google gives it in its regions and zones table
 * (https://cloud.google.com/compute/docs/regions-zones), without the
 * continent. AWS, Alibaba Cloud and Azure name their locations in the bundle.
 *
 * A region missing here keeps its id as its name, so a new one degrades to
 * the code rather than to nothing.
 */
export const GCP_REGION_NAMES: Readonly<Record<string, string>> = {
  "africa-south1": "Johannesburg, South Africa",
  "asia-east1": "Changhua County, Taiwan",
  "asia-east2": "Hong Kong",
  "asia-northeast1": "Tokyo, Japan",
  "asia-northeast2": "Osaka, Japan",
  "asia-northeast3": "Seoul, South Korea",
  "asia-south1": "Mumbai, India",
  "asia-south2": "Delhi, India",
  "asia-southeast1": "Jurong West, Singapore",
  "asia-southeast2": "Jakarta, Indonesia",
  "asia-southeast3": "Bangkok, Thailand",
  "australia-southeast1": "Sydney, Australia",
  "australia-southeast2": "Melbourne, Australia",
  "europe-central2": "Warsaw, Poland",
  "europe-north1": "Hamina, Finland",
  "europe-north2": "Stockholm, Sweden",
  "europe-southwest1": "Madrid, Spain",
  "europe-west1": "St. Ghislain, Belgium",
  "europe-west2": "London, England",
  "europe-west3": "Frankfurt, Germany",
  "europe-west4": "Eemshaven, Netherlands",
  "europe-west6": "Zurich, Switzerland",
  "europe-west8": "Milan, Italy",
  "europe-west9": "Paris, France",
  "europe-west10": "Berlin, Germany",
  "europe-west12": "Turin, Italy",
  "me-central1": "Doha, Qatar",
  "me-central2": "Dammam, Saudi Arabia",
  "me-west1": "Tel Aviv, Israel",
  "northamerica-northeast1": "Montréal, Québec",
  "northamerica-northeast2": "Toronto, Ontario",
  "northamerica-south1": "Querétaro, Mexico",
  "southamerica-east1": "Osasco, São Paulo, Brazil",
  "southamerica-west1": "Santiago, Chile",
  "us-central1": "Council Bluffs, Iowa",
  "us-east1": "Moncks Corner, South Carolina",
  "us-east4": "Ashburn, Virginia",
  "us-east5": "Columbus, Ohio",
  "us-south1": "Dallas, Texas",
  "us-west1": "The Dalles, Oregon",
  "us-west2": "Los Angeles, California",
  "us-west3": "Salt Lake City, Utah",
  "us-west4": "Las Vegas, Nevada",
};

/**
 * A location's display name: the bundle's own `name` attribute when it has
 * one (Alibaba Cloud, Azure), else Google Cloud's from {@link GCP_REGION_NAMES},
 * else the location as the bundle wrote it (AWS's are names already).
 */
export function locationName(
  platform: string,
  location: string,
  attrs: Readonly<Record<string, string | undefined>>,
): string {
  if (attrs["name"]) return attrs["name"];
  if (platform === "gcp") return GCP_REGION_NAMES[attrs["regionCode"] || location] ?? location;
  return location;
}
