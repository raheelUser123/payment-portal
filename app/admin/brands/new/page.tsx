import { requireAdmin } from "@/lib/auth/guard";
import { appBaseUrl } from "@/lib/brands/service";
import { PageHeader, Card } from "@/components/ui";
import { BrandGeneralForm } from "../brand-form";
import { createBrand } from "../actions";

export const metadata = { title: "New brand" };

export default async function NewBrandPage() {
  await requireAdmin();
  return (
    <>
      <PageHeader title="New brand" description="After creating it you can configure email sending, merchants and templates." />
      <Card><BrandGeneralForm action={createBrand} submitLabel="Create brand" appUrl={appBaseUrl()} /></Card>
    </>
  );
}
