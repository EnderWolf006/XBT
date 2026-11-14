declare module "*.yaml" {
  const data: {
    api?: { base_url?: string; timeout?: number };
    sign?: {
      location_presets?: Array<{
        name: string;
        lat: string;
        lng: string;
        description: string;
      }>;
    };
  };
  export default data;
}
