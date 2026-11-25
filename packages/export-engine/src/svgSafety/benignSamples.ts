/**
 * Benign SVG written for the tests in the manner of four common producers: a vector editor with its
 * own namespaces and RDF metadata, a plotting library (glyphs as `<use>`, clip paths, a style block),
 * a diagram editor (HTML labels in `<foreignObject>` with an SVG text fallback inside `<switch>`, and a
 * link footer) and a cheminformatics toolkit (its own namespace, per-atom metadata). Original content;
 * not shipped: imported only by tests.
 */

export const EDITOR_SAMPLE = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!-- Created with a vector editor -->
<svg width="60mm" height="40mm" viewBox="0 0 60 40" version="1.1" id="svg1"
   inkscape:version="1.3" sodipodi:docname="ring.svg"
   xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
   xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
   xmlns:xlink="http://www.w3.org/1999/xlink"
   xmlns="http://www.w3.org/2000/svg"
   xmlns:svg="http://www.w3.org/2000/svg"
   xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
   xmlns:cc="http://creativecommons.org/ns#"
   xmlns:dc="http://purl.org/dc/elements/1.1/">
  <sodipodi:namedview id="namedview1" pagecolor="#ffffff" bordercolor="#666666" inkscape:zoom="2.1" inkscape:document-units="mm"/>
  <defs id="defs1">
    <linearGradient id="linearGradient2" inkscape:collect="always">
      <stop style="stop-color:#1f77b4;stop-opacity:1;" offset="0" id="stop1"/>
      <stop style="stop-color:#ff7f0e;stop-opacity:1;" offset="1" id="stop2"/>
    </linearGradient>
    <linearGradient inkscape:collect="always" xlink:href="#linearGradient2" id="linearGradient3"
       x1="5" y1="5" x2="55" y2="35" gradientUnits="userSpaceOnUse"/>
  </defs>
  <metadata id="metadata1">
    <rdf:RDF>
      <cc:Work rdf:about="">
        <dc:format>image/svg+xml</dc:format>
        <dc:type rdf:resource="http://purl.org/dc/dcmitype/StillImage"/>
        <dc:title>Ring</dc:title>
      </cc:Work>
    </rdf:RDF>
  </metadata>
  <g inkscape:label="Layer 1" inkscape:groupmode="layer" id="layer1">
    <path style="fill:url(#linearGradient3);fill-opacity:1;stroke:#000000;stroke-width:0.5;stroke-linejoin:round"
       d="M 30,5 L 50,15 L 50,30 L 30,38 L 10,30 L 10,15 Z" id="path1" sodipodi:nodetypes="cccccc"/>
    <text xml:space="preserve" style="font-size:4.2px;font-family:sans-serif;fill:#000000" x="22" y="22" id="text1"><tspan
         sodipodi:role="line" id="tspan1" x="22" y="22">C₆H₆</tspan></text>
  </g>
</svg>
`;

export const PLOT_SAMPLE = `<?xml version="1.0" encoding="utf-8" standalone="no"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN"
  "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg xmlns:xlink="http://www.w3.org/1999/xlink" width="230.4pt" height="172.8pt" viewBox="0 0 230.4 172.8" xmlns="http://www.w3.org/2000/svg" version="1.1">
 <metadata>
  <rdf:RDF xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:cc="http://creativecommons.org/ns#" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
   <cc:Work>
    <dc:type rdf:resource="http://purl.org/dc/dcmitype/StillImage"/>
    <dc:date>2026-01-01T00:00:00</dc:date>
    <dc:format>image/svg+xml</dc:format>
   </cc:Work>
  </rdf:RDF>
 </metadata>
 <defs>
  <style type="text/css">*{stroke-linejoin: round; stroke-linecap: butt}</style>
 </defs>
 <g id="figure_1">
  <g id="patch_1">
   <path d="M 0 172.8 L 230.4 172.8 L 230.4 0 L 0 0 z" style="fill: #ffffff"/>
  </g>
  <g id="axes_1">
   <g id="line2d_1">
    <path d="M 40 150 L 80 100 L 120 120 L 160 40" clip-path="url(#p1a2b3c4d5e)" style="fill: none; stroke: #1f77b4; stroke-width: 1.5; stroke-linecap: square"/>
   </g>
   <g id="text_1">
    <g transform="translate(36 162) scale(0.1 -0.1)">
     <defs>
      <path id="Glyph-30" d="M 2034 4250 Q 1547 4250 1301 3770 Q 1056 3291 1056 2328 Q 1056 1369 1301 889 z" transform="scale(0.015625)"/>
      <path id="Glyph-2e" d="M 684 794 L 1344 794 L 1344 0 L 684 0 L 684 794 z" transform="scale(0.015625)"/>
     </defs>
     <use xlink:href="#Glyph-30"/>
     <use xlink:href="#Glyph-2e" x="63.623047"/>
    </g>
   </g>
  </g>
 </g>
 <defs>
  <clipPath id="p1a2b3c4d5e">
   <rect x="28.8" y="20.736" width="178.56" height="133.056"/>
  </clipPath>
 </defs>
</svg>
`;

export const DIAGRAM_SAMPLE = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" width="221px" height="81px" viewBox="-0.5 -0.5 221 81" content="&lt;mxfile&gt;&lt;diagram id=&quot;d1&quot;&gt;compressed&lt;/diagram&gt;&lt;/mxfile&gt;">
<defs/>
<g>
  <rect x="0" y="0" width="120" height="60" rx="9" ry="9" fill="rgb(255, 255, 255)" stroke="rgb(0, 0, 0)" pointer-events="all"/>
  <g transform="translate(-0.5 -0.5)">
    <switch>
      <foreignObject pointer-events="none" width="100%" height="100%" requiredFeatures="http://www.w3.org/TR/SVG11/feature#Extensibility" style="overflow: visible; text-align: left;">
        <div xmlns="http://www.w3.org/1999/xhtml" style="display: flex; width: 118px; padding-top: 30px;"><div style="font-size: 12px; font-family: Helvetica;">Reagent A</div></div>
      </foreignObject>
      <text x="60" y="34" fill="rgb(0, 0, 0)" font-family="Helvetica" font-size="12px" text-anchor="middle">Reagent A</text>
    </switch>
  </g>
  <path d="M 120 30 L 213.63 30" fill="none" stroke="rgb(0, 0, 0)" stroke-miterlimit="10" pointer-events="stroke"/>
  <path d="M 218.88 30 L 211.88 33.5 L 213.63 30 L 211.88 26.5 Z" fill="rgb(0, 0, 0)" stroke="rgb(0, 0, 0)" stroke-miterlimit="10" pointer-events="all"/>
</g>
<switch>
  <g requiredFeatures="http://www.w3.org/TR/SVG11/feature#Extensibility"/>
  <a transform="translate(0,-5)" xlink:href="https://example.com/svg-labels" target="_blank">
    <text text-anchor="middle" font-size="10px" x="50%" y="100%">Labels need a viewer that shows HTML</text>
  </a>
</switch>
</svg>
`;

export const TOOLKIT_SAMPLE = `<?xml version='1.0' encoding='iso-8859-1'?>
<svg version='1.1' baseProfile='full'
              xmlns='http://www.w3.org/2000/svg'
                      xmlns:rdkit='http://www.rdkit.org/xml'
                      xmlns:xlink='http://www.w3.org/1999/xlink'
                  xml:space='preserve'
width='250px' height='200px' viewBox='0 0 250 200'>
<!-- END OF HEADER -->
<rect style='opacity:1.0;fill:#FFFFFF;stroke:none' width='250.0' height='200.0' x='0.0' y='0.0'> </rect>
<path class='bond-0 atom-0 atom-1' d='M 20.0,100.0 L 60.0,77.0' style='fill:none;fill-rule:evenodd;stroke:#000000;stroke-width:2.0px;stroke-linecap:butt;stroke-linejoin:miter;stroke-opacity:1' />
<path class='bond-1 atom-1 atom-2' d='M 60.0,77.0 L 100.0,100.0' style='fill:none;fill-rule:evenodd;stroke:#000000;stroke-width:2.0px;stroke-linecap:butt;stroke-linejoin:miter;stroke-opacity:1' />
<path class='atom-2' d='M 104.0 96.0 Q 108.0 92.0 112.0 96.0' fill='#FF0000'/>
<metadata>
<rdkit:mol xmlns:rdkit = "http://www.rdkit.org/xml" version="0.9">
<rdkit:atom idx="1" atom-smiles="[CH3]" drawing-x="20.0" drawing-y="100.0" x="-1.3" y="0.0" z="0.0" />
<rdkit:atom idx="2" atom-smiles="[CH2]" drawing-x="60.0" drawing-y="77.0" x="0.0" y="0.75" z="0.0" />
<rdkit:atom idx="3" atom-smiles="[OH]" drawing-x="100.0" drawing-y="100.0" x="1.3" y="0.0" z="0.0" />
<rdkit:bond idx="1" begin-atom-idx="1" end-atom-idx="2" bond-smiles="-" />
<rdkit:bond idx="2" begin-atom-idx="2" end-atom-idx="3" bond-smiles="-" />
</rdkit:mol></metadata>
</svg>
`;
