export interface AboutComponent {
  name: string;
  version: string;
  license: string;
  purpose: string;
  sourceUrl: string;
  licenseText?: string;
}

export interface AboutProvenance {
  components: AboutComponent[];
  licenseTexts: Record<string, string>;
}
