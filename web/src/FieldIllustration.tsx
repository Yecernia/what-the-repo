import { BrandWordmark } from './BrandWordmark';
import { penPath, smoothPath, type PenPoint } from './pen-path';

function Ink({ points, width = 4.2, closed = false, fill, color = 'currentColor', className }: {
  points: PenPoint[]; width?: number; closed?: boolean; fill?: string; color?: string; className?: string;
}) {
  return <g className={className}>
    {fill && <path d={smoothPath(points, true)} fill={fill} />}
    <path d={penPath(points, width, closed)} fill={color} fillRule="evenodd" />
  </g>;
}

/** Original faceless learner, drawn with weighted pen outlines rather than a uniform stroke. */
export function FieldMark() {
  return <svg className="field-mark" viewBox="0 0 44 44" aria-hidden="true" focusable="false">
    <Ink points={[[20,7,.9],[14,6,1.2],[11,10,.9],[12,15,1.1],[17,17,.85],[22,15,1.2],[23,10,.9]]} closed width={2.3} />
    <Ink points={[[11,20,.85],[7,26,1.2],[9,36,.9],[19,37,1.1],[20,30,.8]]} width={2.6} />
    <Ink points={[[22,22,.85],[29,22.5,1.1],[38,22,.85],[37,28,1.1],[35.5,34.5,.9],[29,35,1.15],[23,34,.85],[22,28,1.1]]} width={2.2} closed />
    <Ink points={[[20,37,.8],[26,38.5,1.1],[35,38,.85],[39,36,1.1]]} width={1.9} />
    <Ink points={[[30,8,.7],[32,5,1.1]]} width={1.8} />
    <Ink points={[[34,13,.8],[38,12,1.1]]} width={1.8} />
  </svg>;
}

export function FieldScene({ className = '' }: { className?: string }) {
  return <figure className={`field-scene ${className}`}><FieldIllustration />
    <figcaption aria-label="what-the-repo"><BrandWordmark /><svg className="field-name-line" viewBox="0 0 260 14" aria-hidden="true"><path d="M4 8 Q60 3 112 8 T254 5" pathLength="100" /></svg></figcaption>
  </figure>;
}

export function FieldIllustration({ compact = false, className = '' }: { compact?: boolean; className?: string }) {
  if (compact) return <svg className={`field-illustration field-illustration-small ${className}`} viewBox="0 0 240 150" aria-hidden="true" focusable="false">
    {/* Front view: the laptop naturally hides the hands, with no detached fingers. */}
    <Ink points={[[111,29,.85],[101,33,1.2],[97,42,1.1],[100,52,.9],[111,56,1.15],[123,53,.85],[127,43,1.2],[123,33,.9]]} width={3.6} closed />
    <Ink points={[[96,60,.85],[84,70,1.2],[80,94,.9],[83,115,1.1],[148,115,.85],[149,89,1.2],[141,68,.9],[126,60,1.1]]} width={3.6} closed />
    <Ink points={[[69,79,.85],[86,80,1.2],[149,79,.9],[171,81,1.1],[169,98,.85],[166,120,1.2],[148,121,.9],[91,120,1.15],[74,119,.85],[71,98,1.1]]} width={3.3} closed fill="var(--chat-bg)" />
    {/* We see the plain back of the lid and its thin bottom edge, not the screen or keyboard. */}
    <Ink points={[[70,122,.85],[89,125,1.1],[149,126,.9],[171,123,1.1]]} width={2.6} />
    <Ink points={[[153,39,.7],[157,31,1.1]]} width={2.4} />
    <Ink points={[[164,50,.7],[176,47,1.1]]} width={2.4} />
  </svg>;
  return <svg className={`field-illustration ${className}`} viewBox="0 0 600 440" aria-hidden="true" focusable="false">
    {/* An open-air study spot: a leaning tree, a long park bench and a little breeze. */}
    {/* A few generous foliage lobes and a tapered trunk, with varied hand pressure. */}
    <Ink className="field-canopy" points={[[128,272,.65],[104,272,1.15],[78,260,.9],[65,240,1.2],[64,220,.85],[74,204,1.1],[87,197,.8],[76,177,1.15],[74,155,.9],[84,138,1.2],[101,129,.85],[118,130,1.05],[124,109,.85],[143,92,1.15],[165,89,.9],[186,98,1.2],[196,115,.8],[214,120,1.1],[229,137,.9],[230,157,1.15],[216,176,.85],[231,193,1.1],[234,213,.85],[225,232,1.2],[214,239,.8],[222,257,1.1],[216,277,.9],[195,289,1.15],[174,288,.85],[160,282,.65]]} width={4.5} color="var(--accent)" fill="color-mix(in srgb, var(--accent-soft) 30%, var(--bg))" />
    <g fill="color-mix(in srgb, var(--fg) 80%, var(--warn) 20%)">
      <path d="M139 371 Q135 349 139 318 L143 270 L155 270 L157 320 Q162 354 159 371 Q151 377 139 371Z" />
      <path className="field-branches" d="M143 276 L143 267 Q143 241 136 229 Q124 214 115 201 Q112 193 121 198 L143 218 L151 143 Q152 135 155 143 L158 202 Q169 190 180 174 Q186 166 187 174 Q180 194 160 220 Q155 249 155 274 L155 276Z" />
    </g>
    {/* The bench remains one simple background shape, with clear space below the seat. */}
    <Ink points={[[246,207,.85],[308,209,1.1],[371,206,.9],[443,208,1.15],[444,231,.85],[367,230,1.15],[305,233,.9],[245,230,1.1]]} width={3.8} closed fill="var(--bg)" />
    <Ink points={[[256,233,.8],[257,288,1.1]]} width={3.3} />
    <Ink points={[[430,231,.8],[427,290,1.1]]} width={3.3} />
    <Ink points={[[232,291,.85],[295,290,1.1],[365,293,.9],[457,291,1.15],[459,304,.85],[379,307,1.1],[296,304,.9],[232,305,1.1]]} width={3.8} closed fill="var(--bg)" />
    <Ink points={[[253,308,.8],[250,339,1.1],[253,373,.75]]} width={3.8} />
    <Ink points={[[435,308,.8],[435,340,1.1],[438,373,.75]]} width={3.8} />
    {/* Broad sleeves and roomy trouser shapes, without narrow wrists or separate shoes. */}
    <Ink points={[[345,288,.85],[375,301,1.15],[385,325,.9],[386,347,1.1],[382,368,.85],[364,371,1.1],[343,368,.9],[341,344,1.15],[334,316,.85]]} width={5.2} closed fill="var(--bg)" />
    <Ink points={[[297,291,.85],[323,298,1.15],[336,313,.9],[334,338,1.1],[331,369,.85],[312,372,1.15],[289,369,.9],[285,345,1.1],[280,322,.85],[279,308,1.15]]} width={5.4} closed fill="var(--bg)" />
    <Ink points={[[305,196,.85],[283,212,1.15],[268,240,.9],[272,272,1.2],[298,293,.85],[352,300,1.1],[381,289,.9],[395,263,1.2],[389,233,.85],[369,211,1.1],[344,198,.9]]} width={5.5} closed fill="var(--bg)" />
    <Ink points={[[313,147,.85],[297,150,1.2],[289,162,1.1],[291,178,.9],[304,188,1.2],[323,187,.85],[338,178,1.1],[339,165,1.2],[328,150,.85]]} width={4.8} closed fill="var(--bg)" />
    <Ink points={[[291,221,.85],[280,244,1.15],[285,260,.9]]} width={4.6} />
    <Ink points={[[357,212,.85],[380,233,1.1],[389,258,.9],[384,280,1.2],[366,290,.85],[337,286,1.1],[327,276,.9],[332,260,1.15],[352,261,.85],[358,250,1.1],[350,232,.9]]} width={5.1} fill="var(--bg)" />
    {/* The plain rear of the lid faces us; the screen and hands are on the person's side. */}
    <Ink points={[[247,239,.85],[273,241,1.1],[309,243,.9],[343,245,1.2],[343,263,.85],[339,287,1.1],[309,288,.9],[264,284,1.2],[258,266,.85],[252,252,1.1]]} width={4.2} closed fill="var(--panel)" />
    <Ink points={[[258,289,.85],[298,293,1.1],[341,292,.85]]} width={3.1} />
    <Ink className="field-breeze" points={[[396,139,.7],[417,135,1.1],[437,138,.8]]} width={2.4} color="var(--accent)" />
    <Ink className="field-breeze field-breeze-second" points={[[413,151,.7],[443,148,1.1],[462,151,.75]]} width={2.4} color="var(--accent)" />
    <Ink points={[[484,346,.75],[493,363,1.1],[501,345,.8]]} width={3} color="var(--accent)" />
    <Ink points={[[111,355,.7],[122,371,1.1],[128,355,.75]]} width={3} color="var(--accent)" />
    <Ink points={[[101,379,.7],[170,377,1.15],[222,379,.85],[269,378,.7]]} width={2.6} />
    <Ink points={[[290,381,.75],[365,379,1.1],[433,381,.85],[508,377,.7]]} width={2.6} />
  </svg>;
}
