import { getSignInUrl } from "@workos-inc/authkit-nextjs";
import { redirect } from "next/navigation";

export default async function SignInPage() {
  const url = await getSignInUrl();
  redirect(url);
}
