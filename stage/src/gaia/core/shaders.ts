// GLSL for the holographic GAIA core. Colours are authored in display space
// (brand hex values) and summed additively into a half-float buffer; the final
// pass rolls off highlights, so a hot centre reads as lavender-white.

// Ashima Arts 3D simplex noise (MIT).
export const NOISE = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1./289.))*289.;}
vec4 mod289(vec4 x){return x-floor(x*(1./289.))*289.;}
vec4 permute(vec4 x){return mod289(((x*34.)+1.)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1./6.,1./3.);const vec4 D=vec4(0.,.5,1.,2.);
  vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.-g;vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.,i1.z,i2.z,1.))+i.y+vec4(0.,i1.y,i2.y,1.))+i.x+vec4(0.,i1.x,i2.x,1.));
  float n_=.142857142857;vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.*x_);
  vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.+1.;vec4 s1=floor(b1)*2.+1.;vec4 sh=-step(h,vec4(0.));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.);m=m*m;
  return 42.*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}`;

// Brand palette: lavender #F0E9FF, violet on dark #A97DFF, bright violet
// #7A20F9, deep violet #4114C0, lime #8DFA44.
export const PALETTE = /* glsl */ `
const vec3 LAV=vec3(.941,.914,1.);
const vec3 VIO=vec3(.663,.49,1.);
const vec3 BRI=vec3(.478,.125,.976);
const vec3 DEEP=vec3(.255,.078,.753);
const vec3 LIME=vec3(.553,.98,.267);
float h11(float n){return fract(sin(n*127.1)*43758.5453);}
float h21(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
mat2 rot(float a){float c=cos(a),s=sin(a);return mat2(c,-s,s,c);}`;

// Shared point fragment: a crisp gaussian when in focus, a soft bokeh disc
// with a faint rim when out of focus.
export const POINT_FRAG = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
varying float vSoft;
void main(){
  vec2 q=gl_PointCoord*2.-1.;
  float d=dot(q,q);
  if(d>1.)discard;
  float sharp=exp(-d*6.5)+exp(-d*2.)*.16;
  float disc=(1.-smoothstep(.62,1.,d))*(.55+.45*d);
  float a=mix(sharp,disc*.7,vSoft);
  gl_FragColor=vec4(vColor,a*vAlpha);
}`;

// ---------------------------------------------------------------------------
// The mind: Fibonacci shell (kind 0), geodesic lattice (kind 1, points along
// the edges of a subdivided icosahedron), inner volume (kind 2).
export const CORE_VERT = /* glsl */ `
uniform float uTime,uPR,uSize,uFocus,uDof,uSpin,uLatSpin,uSwirl,uTurb,uScale,uBright,uVoice,uPulse,uBreath;
uniform float uListen,uThink,uTool,uSpeak,uGuard,uVerified;
uniform float uScanY,uScanAmt,uSweepY,uSynT,uSynRate,uTintAmt,uFlick,uShapeGain,uShell,uCoreVis,uCollapse,uBurst;
uniform vec4 uGlyph; // slot A: in, out; slot B: in, out
uniform float uGlyphOn,uIntro;
uniform vec3 uTint;
uniform vec3 uTrail[10];
uniform vec2 uPointer;
attribute vec4 aSeed;
attribute vec3 aInfo;
attribute vec4 aGlyphA,aGlyphB; // x, y, z, s (share of the drawing; -1 = not in the glyph)
varying vec3 vColor;
varying float vAlpha;
varying float vSoft;
${NOISE}
${PALETTE}
// One glyph slot. io.x: in (sphere -> centre -> glyph), io.y: out (hang ->
// centre -> sphere). Non-members pass through the centre too and return to
// the sphere. k: how much the point is part of the drawn symbol; c: how
// near the centre it is.
float smoother(float x){return x*x*x*(x*(x*6.-15.)+10.);}
vec3 glyphSlot(vec3 sp,vec4 g,vec2 io,vec3 centre,out float k,out float c){
  float member=step(0.,g.w);
  float s=max(g.w,0.);
  vec3 target=mix(sp,g.xyz,member);
  // In: gather with growing speed, then open out, the pen front moving along s.
  float gather=clamp(io.x/.36,0.,1.);
  gather=gather*gather*gather;
  // Out of the centre with a soft start and a soft landing (smootherstep).
  float open=clamp((io.x-.4)/.6*1.3-s*.3*member,0.,1.);
  open=open*open*open*(open*(open*6.-15.)+10.);
  float opening=step(.4,io.x);
  vec3 pin=mix(mix(sp,centre,gather),mix(centre,target,open),opening);
  float kin=opening*open*member;
  float cin=mix(gather,1.-open,opening);
  // Out: a slight drift and a hang, the fall into the centre, the sphere opens.
  float drift=smoothstep(0.,.22,io.y);
  float fall=clamp((io.y-.3)/.46,0.,1.);
  fall=pow(fall,2.6);
  float back=clamp((io.y-.76)/.24,0.,1.);
  back=back*back*back*(back*(back*6.-15.)+10.);
  float returning=step(.76,io.y);
  vec3 held=target*(1.+.045*drift);
  vec3 pout=mix(mix(held,centre,fall),mix(centre,sp,back),returning);
  float kout=member*(1.-fall)*(1.-returning);
  float cout=mix(fall,1.-back,returning);
  float leaving=step(1e-4,io.y);
  k=mix(kin,kout,leaving);
  c=mix(cin,cout,leaving)*step(1e-4,io.x+io.y);
  return mix(pin,pout,leaving);
}
void main(){
  float kind=aInfo.x;
  float isShell=1.-step(.5,kind);
  float isLat=step(.5,kind)*(1.-step(1.5,kind));
  float isVol=step(1.5,kind);
  vec3 p=position;
  float r=length(p);
  vec3 dir=p/max(r,1e-4);

  // The lattice counter-rotates against the shell: layered depth.
  float ang=mix(uSpin,uLatSpin,isLat)+isVol*uSwirl*(.35+(1.-abs(dir.y))*.9)*(.6+.8*aSeed.z);
  mat2 R=rot(ang);
  p.xz=R*p.xz;
  dir.xz=R*dir.xz;

  // Guard: the shell and volume draw in, the lattice becomes a shield cage.
  p*=1.+isLat*uGuard*.17-isShell*uGuard*.06-isVol*uGuard*.12;

  vec3 q=p*1.5+vec3(0.,uTime*.12,uTime*.05);
  float n=snoise(q);
  p+=dir*n*uTurb*.11*(1.-isLat*.75);
  // Inner flow: cheap curl-ish drift for the volume.
  p+=isVol*vec3(sin(q.y*2.1+uTime*.7),sin(q.z*1.9-uTime*.6),sin(q.x*2.3+uTime*.5))*uTurb*.05;

  // Voice: the skin vibrates with the voice, in moving patches.
  float vn=snoise(dir*2.3+vec3(0.,uTime*.9,uTime*1.9));
  p+=dir*uVoice*(.025+.1*max(vn,0.))*(isShell+isLat*.6);
  // Listening: the lower hemisphere leans toward the input line.
  p.y-=uListen*smoothstep(.15,-1.,dir.y)*.075*(1.-isLat*.5);
  float wave=sin(dir.y*7.-uTime*8.+aSeed.z)*uPulse;
  p*=(1.+uBreath*.018)*(1.+wave*.028);

  // Every change of form passes through the centre, like a film cut: the
  // sphere folds into the nucleus, the symbol opens out of it (drawn in stroke
  // order, s), and when it goes it drifts, hangs a moment, falls into the
  // centre with growing speed, and the sphere opens again. Two slots (A, B).
  p*=uScale;
  vec3 centre=(vec3(h11(aSeed.x*91.7),h11(aSeed.y*57.3),h11(aSeed.z*33.1))-.5)*.035;
  // Her entrance (uIntro 0..1; slot A holds the Seasons mark meanwhile): the
  // particles drift in as faint dust, gather into the Seasons mark in stroke
  // order, the mark folds into the centre with growing speed, and the sphere
  // opens out of it.
  float introMark=0.;
  float introCentre=0.;
  float introAlpha=1.;
  if(uIntro<1.){
    vec3 hj=vec3(h11(aSeed.x*17.3),h11(aSeed.y*41.9),h11(aSeed.w*23.7))-.5;
    vec3 dust=dir*(1.6+aSeed.y*2.4)+hj*vec3(4.,2.4,1.2);
    dust.z*=.4;
    dust+=hj.yzx*.18*sin(uTime*.35+aSeed.z*6.28);
    float im=step(0.,aGlyphA.w);
    float form=smoother(clamp((uIntro-.08-max(aGlyphA.w,0.)*.14)/.3,0.,1.));
    float fold=pow(clamp((uIntro-.62)/.18,0.,1.),2.6);
    float open=smoother(clamp((uIntro-.8)/.2,0.,1.));
    vec3 drawn=mix(dust,aGlyphA.xyz,form*im);
    drawn=mix(drawn,dust*.75,(1.-im)*form*.35);
    p=mix(mix(drawn,centre,fold),p,open);
    introMark=im*form*(1.-fold);
    introCentre=fold*(1.-open);
    introAlpha=smoothstep(0.,.14,uIntro)*mix(.14,1.,max(im*form,open));
  }
  float kA,kB,cA,cB;
  vec3 pa=glyphSlot(p,aGlyphA,uGlyph.xy,centre,kA,cA);
  p=glyphSlot(pa,aGlyphB,uGlyph.zw,centre,kB,cB);
  float k=max(max(kA,kB),introMark);
  float atCentre=max(max(cA,cB),introCentre);
  float sLine=introMark>0.?max(aGlyphA.w,0.):mix(max(aGlyphA.w,0.),max(aGlyphB.w,0.),step(kA,kB));
  // A slow light runs along the finished line.
  float runner=exp(-pow(fract(sLine-uTime*.3)-.5,2.)*90.)*k*k;
  float glyphOn=uGlyphOn;

  // The end of thinking, in three beats: a short blast, a hang (bullet time),
  // then the pull into the nucleus, faster and faster (uBurst: 0..1, 0 = none).
  float burstOut=0.;
  float burstHang=0.;
  if(uBurst>0.){
    float ex=clamp(uBurst/.16,0.,1.);
    ex=1.-pow(1.-ex,4.);
    float hang=smoothstep(.16,.5,uBurst);
    float fall=clamp((uBurst-.46)/.54,0.,1.);
    fall=pow(fall,2.6);
    // Mostly across the view, not at the camera, so nothing balloons into a blur.
    vec3 blast=dir*(.16+aSeed.y*.34)+(vec3(h11(aSeed.x*13.1),h11(aSeed.y*29.7),h11(aSeed.w*7.9))-.5)*.18;
    blast.z*=.35;
    vec3 flung=p+blast*(ex+hang*.06);
    flung.xy=rot(hang*.07*(aSeed.z-.5))*flung.xy;
    vec3 inward=mix(flung,centre,fall);
    inward.xy=rot(fall*(1.-fall)*1.6*(aSeed.z-.5))*inward.xy;
    p=inward;
    burstOut=ex*(1.-fall);
    burstHang=hang*(1.-fall);
    atCentre=max(atCentre,fall);
  }

  // Speaking: the mind pours into its nucleus and follows the living point
  // as a trail of sparks (uTrail: its recent positions, newest first).
  float cl=clamp(uCollapse*1.6-aSeed.z*.6,0.,1.);
  cl=cl*cl*(3.-2.*cl);
  // Each particle takes its own place along the path between two samples: a smooth comet tail.
  float tt=aSeed.w*8.999;
  int ti=int(floor(tt));
  float tf=aSeed.w;
  vec3 jit=(vec3(h11(aSeed.x*91.7),h11(aSeed.y*57.3),h11(aSeed.z*33.1))-.5)*(.015+tf*tf*.2);
  p=mix(p,mix(uTrail[ti],uTrail[ti+1],fract(tt))+jit,cl);

  vec4 mv=modelViewMatrix*vec4(p,1.);
  gl_Position=projectionMatrix*mv;

  // Light: rim, an attention key light that follows the pointer (and looks
  // down to the input while listening), a slow scan band, the lime sweep.
  vec3 nV=normalize((modelViewMatrix*vec4(dir,0.)).xyz);
  float rim=pow(1.-abs(nV.z),2.4)*(1.-k);
  vec3 L=normalize(vec3(uPointer.x*.95,uPointer.y*.75+.3-uListen*1.6,.85));
  float att=pow(max(dot(nV,L),0.),4.)*(1.-k*.6);
  float py=p.y/max(uScale,.1);
  float scan=exp(-pow((py-uScanY)*13.,2.))*uScanAmt*(1.-step(1e-4,uBurst));
  float calm=1.-step(1e-4,uBurst);
  float sweep=exp(-pow((py-uSweepY)*17.,2.))*uTool*calm;

  // Synapses: pulses run along lattice edges.
  float eh=aInfo.y;
  float cyc=uSynT*(.45+h11(eh*7.3))+eh*31.;
  float fire=step(1.-uSynRate,h11(eh*17.+floor(cyc)));
  float head=fract(cyc)*1.5-.25;
  float syn=isLat*fire*exp(-pow((aInfo.z-head)*11.,2.))*(1.-k);

  float inner=isVol*smoothstep(.85,.08,r);
  float spark=step(.976,aSeed.w);
  vec3 c=mix(BRI,VIO,aSeed.y*.75);
  c=mix(c,DEEP,uThink*.4*(1.-inner));
  c=mix(c,LAV,clamp(att*.5+rim*.45+inner*.6+scan*.7+syn+isLat*.3+uGuard*isLat*.3,0.,1.));
  c=mix(c,LIME,clamp(sweep*.9+spark*uTool*.9+rim*uVerified*.5+spark*uVerified*.6,0.,1.));
  c=mix(c,uTint,uTintAmt*k*(.55+.45*aSeed.y));
  c=mix(c,vec3(1.),runner*.3);

  float a=isShell*(.2+.22*aSeed.y)+isLat*(.34+syn*2.2+uGuard*.45+uVerified*.1+uThink*.12)+isVol*(.06+.26*inner)*(1.+uThink*.9+uSpeak*uVoice*.8);
  a*=.5+att*(1.15+uListen*1.6)+rim*1.25+scan*1.6+sweep*2.2+spark*(uTool+uVerified)*1.5;
  a*=uBright*(1.+uVoice*.45);
  // Glyph points: an even, bright line; the rest of the sphere steps back.
  a=mix(a,(.55+.45*aSeed.y)*uShapeGain*uBright,k);
  a*=1.+runner*.8;
  a*=mix(1.,.3,glyphOn*(1.-k));
  // Crowded into the centre, each point dims, so the nucleus glows without burning.
  a*=1.-atCentre*.65;
  a*=introAlpha;
  a*=1.+burstOut*.35;
  // In the hang, a few points glint, as if time had stopped around them.
  a*=1.+burstHang*1.4*pow(.5+.5*sin(uTime*7.+aSeed.w*40.),10.);
  // Waiting: the skin dissolves in slow patches and the inner core shows through;
  // it gathers back as GAIA listens, thinks and speaks. Shapes stay whole.
  float dn=snoise(dir*1.6+vec3(uTime*.05,-uTime*.04,uTime*.03))*.5+.5;
  float skin=max(smoothstep(0.,1.,uShell*1.65-dn*.65),.05);
  a*=mix(mix(1.,skin,isShell+isLat),1.,k);
  a*=1.+isVol*(uCoreVis-1.)*(.45+inner);
  // In the trail only a fraction of the particles stay lit, dimmer toward the tail.
  float keep=step(aSeed.x,.3)*pow(1.-tf,1.6)*1.4;
  a=mix(a,keep*(.5+uVoice*.8),cl);
  c=mix(c,mix(LAV,VIO,tf),cl*.8);

  // Depth of field around a focal plane just in front of the centre.
  float depth=-mv.z;
  float coc=abs(depth-uFocus);
  float blur=smoothstep(.3,1.7,coc)*uDof*(1.-k*.7)*(1.-burstOut*.85);
  vSoft=blur;
  float size=uSize*(.6+aSeed.y*.8)*(1.-isLat*.3)*(1.+inner*.4+syn*.45+sweep*.9+spark*.9*(.3+uTool+uVerified));
  size*=1.+blur*2.3;
  a/=1.+blur*blur*4.;
  size*=mix(1.,1.1-tf*.5,cl);
  size*=mix(1.,.72,k)*(1.-atCentre*.35);
  vAlpha=a*uFlick;
  vColor=c;
  gl_PointSize=size*uPR*(uFocus/depth);
}`;

// ---------------------------------------------------------------------------
// Orbit lines: thin tilted rings around the mind, each with a travelling comet.
export const RING_VERT = /* glsl */ `
varying vec2 vPos;
void main(){
  vPos=position.xy;
  gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);
}`;

export const RING_FRAG = /* glsl */ `
uniform float uR0,uR1,uAlpha,uPhase,uVoice,uSpeak,uThink,uTool,uVerified,uFormed,uFlick,uDir;
varying vec2 vPos;
${PALETTE}
void main(){
  float rad=length(vPos);
  float fwR=fwidth(rad);
  float band=smoothstep(uR0-fwR,uR0+fwR,rad)*(1.-smoothstep(uR1-fwR,uR1+fwR,rad));
  if(band<=0.)discard;
  float a=atan(vPos.y,vPos.x);
  float au=fract(a/6.28318);
  float d=fract(uDir*(a/6.28318-uPhase));
  float tail=exp(-d*6.)*1.5+exp(-(1.-d)*90.)*.8;
  float dash=.55+.45*step(.5,fract(au*90.));
  float v=.2*dash+tail*(.8+uThink*.5+uSpeak*uVoice*.8);
  vec3 col=mix(VIO,LAV,clamp(tail*.7,0.,1.));
  col=mix(col,LIME,clamp(uTool*.8+uVerified*.4,0.,1.)*clamp(tail,0.,1.));
  gl_FragColor=vec4(col,v*band*uAlpha*(1.-uFormed*.45)*uFlick);
}`;

// ---------------------------------------------------------------------------
// Camera-facing quads around the centre: nucleus glow, anamorphic streak,
// verification shockwave and the lime laser sweep.
export const QUAD_VERT = /* glsl */ `
varying vec2 vP;
void main(){
  vP=position.xy;
  gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);
}`;

export const NUCLEUS_FRAG = /* glsl */ `
uniform float uEnergy,uFormed,uTool,uVerified,uGuard,uThink,uTime,uFlick;
varying vec2 vP;
${PALETTE}
void main(){
  float d=length(vP);
  float flick=1.+uThink*.18*sin(uTime*23.)*sin(uTime*7.1);
  float e=uEnergy*flick;
  float hot=exp(-d*d*180.)*1.1;
  float body=exp(-d*d*26.)*.22;
  float wide=exp(-d*d*3.)*.06;
  vec3 c=LAV*hot*e+mix(BRI,VIO,.35)*body*e+mix(DEEP,BRI,.45)*wide*(.7+.3*e);
  c+=LIME*(body*.5+hot*.15)*(uTool*.45+uVerified*.8);
  c=mix(c,c*vec3(.85,.8,1.05),uGuard);
  c*=1.-uFormed*.93;
  gl_FragColor=vec4(c*uFlick,1.);
}`;

export const STREAK_FRAG = /* glsl */ `
uniform float uStreak,uFormed,uFlick;
varying vec2 vP;
${PALETTE}
void main(){
  float x=abs(vP.x),y=abs(vP.y);
  float line=exp(-y*110.)*exp(-x*.75);
  float soft=exp(-y*y*420.)*exp(-x*x*.9)*.45;
  float glint=exp(-y*28.)*exp(-x*5.)*.35;
  vec3 c=mix(BRI,LAV,exp(-x*1.6))*(line+soft)+LAV*glint;
  gl_FragColor=vec4(c*uStreak*(1.-uFormed*.8)*uFlick,1.);
}`;

export const WAVE_FRAG = /* glsl */ `
uniform float uVerified,uTime,uPulse,uSpeak;
varying vec2 vP;
${PALETTE}
float ringAt(float d,float t,float r0,float span){
  float R=r0+t*span; float w=.006+t*.03;
  return exp(-pow((d-R)/w,2.))*pow(1.-t,2.)*smoothstep(0.,.08,t);
}
void main(){
  float d=length(vP);
  float t1=fract(uTime*.42),t2=fract(uTime*.42+.5);
  float v=(ringAt(d,t1,1.12,1.05)+ringAt(d,t2,1.12,1.05))*uVerified;
  // Speech chunks send a faint violet ripple.
  float s=ringAt(d,clamp(1.-uPulse,0.,1.),1.02,.9)*uPulse*uSpeak*.7;
  vec3 c=LIME*v*.5+VIO*s;
  gl_FragColor=vec4(c,1.);
}`;

export const SWEEP_FRAG = /* glsl */ `
uniform float uTool,uSweepY,uSweepV,uTime,uCalm;
varying vec2 vP;
${PALETTE}
void main(){
  float y=vP.y-uSweepY;
  float chord=sqrt(max(1.3*1.3-uSweepY*uSweepY,0.));
  float xs=1.-smoothstep(chord*.7,chord+.25,abs(vP.x));
  float line=exp(-abs(y)*140.)*xs;
  float haze=exp(-abs(y)*22.)*xs*.18;
  // Scanned area behind the beam keeps a faint afterglow.
  float trail=step(0.,y*sign(uSweepV))*exp(-abs(y)*5.)*xs*.05;
  float tick=step(.92,fract(vP.x*9.+uTime*2.))*exp(-abs(y)*60.)*xs*.6;
  vec3 c=LIME*(line*1.2+haze+trail+tick)+LAV*line*.25;
  gl_FragColor=vec4(c*uTool*uCalm,1.);
}`;

// ---------------------------------------------------------------------------
// Chain-read data streams: packets of lime points flowing into the core.
export const STREAM_VERT = /* glsl */ `
uniform float uStreamT,uTool,uPR,uFocus;
attribute vec4 aS;
attribute float aQ;
varying vec3 vColor;
varying float vAlpha;
varying float vSoft;
${PALETTE}
void main(){
  float ang=aS.x;
  float t=fract(uStreamT*aS.y+aS.z);
  vec3 A=vec3(cos(ang)*3.6,sin(ang)*2.4,-1.6+aS.w*2.2);
  vec3 B=normalize(vec3(cos(ang),sin(ang),aS.w-.3))*1.04;
  vec3 C=mix(A,B,.45)+vec3(-sin(ang),cos(ang),0.)*(aS.w-.5)*1.8;
  float e=t*t*(1.6-.6*t);
  vec3 p=mix(mix(A,C,e),mix(C,B,e),e);
  vec4 mv=modelViewMatrix*vec4(p,1.);
  gl_Position=projectionMatrix*mv;
  vAlpha=uTool*smoothstep(0.,.4,t)*(1.-smoothstep(.88,1.,t))*(1.-aQ)*(1.-aQ)*1.5;
  vColor=mix(LIME,LAV,t*t*.45);
  vSoft=0.;
  gl_PointSize=(1.2+1.8*t)*(1.-aQ*.6)*uPR*(uFocus/-mv.z);
}`;

// ---------------------------------------------------------------------------
// Parallax data particles far and near, with strong depth of field.
export const DUST_VERT = /* glsl */ `
uniform float uTime,uPR,uFocus,uTool,uWispOn;
uniform vec2 uPointer;
uniform vec3 uWisp;
attribute vec4 aD;
varying vec3 vColor;
varying float vAlpha;
varying float vSoft;
${PALETTE}
void main(){
  vec3 p=position;
  p.y=mod(p.y+uTime*(.025+aD.x*.05)+6.,12.)-6.;
  p.x+=sin(uTime*.08+aD.y*6.28)*.25+sin(uTime*.05+p.y*.35+aD.x*9.)*.35;
  p.z+=cos(uTime*.04+p.x*.3+aD.w*7.)*.3;
  // Motes near GAIA's living point part around it and catch its light.
  vec3 toW=p-uWisp;
  float near=exp(-dot(toW,toW)*1.6)*uWispOn;
  p+=normalize(toW+vec3(1e-4))*near*.4;
  float par=(p.z+3.)*.06;
  p.xy-=uPointer*par;
  vec4 mv=modelViewMatrix*vec4(p,1.);
  gl_Position=projectionMatrix*mv;
  float depth=-mv.z;
  float blur=clamp(abs(depth-uFocus)*.28,0.,1.);
  float tw=.6+.4*sin(uTime*(.5+aD.y*1.6)+aD.x*40.);
  float a=(.17+.48*aD.z*aD.z)*tw/(1.+blur*blur*11.);
  float sy=gl_Position.y/gl_Position.w;
  a*=smoothstep(-1.,-.45,sy);
  a+=near*.55/(1.+blur*blur*8.);
  vAlpha=a;
  vSoft=blur;
  vColor=mix(mix(VIO,LAV,aD.z),LAV,near);
  vColor=mix(vColor,LIME,step(.93,aD.w)*uTool*.8);
  gl_PointSize=min((1.3+aD.z*2.2+blur*22.)*uPR*(uFocus/depth)*(1.+near*.8),56.*uPR);
}`;

// ---------------------------------------------------------------------------
// Final: chromatic fringe, brightness-weighted scanlines, hologram flicker
// and line glitch, highlight roll-off, vignette, grain.
export const FINAL_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 uRes,uCoreUv;
uniform float uTime,uAberr,uScan,uGlitch,uGrain;
varying vec2 vUv;
float hs(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}
void main(){
  vec2 uv=vUv;
  float line=floor(uv.y*90.);
  float gl=step(.93,hs(vec2(line,floor(uTime*30.))))*uGlitch;
  uv.x+=gl*(hs(vec2(line,3.))-.5)*.006;
  vec2 dir=uv-uCoreUv;
  float ab=uAberr*(1.+uGlitch*1.6);
  vec3 c;
  c.r=texture2D(tDiffuse,uv+dir*ab).r;
  c.g=texture2D(tDiffuse,uv).g;
  c.b=texture2D(tDiffuse,uv-dir*ab).b;
  float lum=dot(c,vec3(.3,.5,.2));
  float sl=.5+.5*sin((gl_FragCoord.y/uRes.y)*3.14159*uRes.y*.33);
  c*=1.-uScan*smoothstep(.04,.5,lum)*sl;
  vec3 x=max(c-.72,0.);
  c=min(c,.72)+.28*(1.-exp(-x*3.2));
  vec2 v=(vUv-.5)*vec2(uRes.x/uRes.y,1.);
  c*=mix(1.,smoothstep(1.3,.3,length(v*vec2(.85,1.))),.55);
  c+=(hs(vUv*uRes+fract(uTime*7.)*91.)-.5)*uGrain;
  gl_FragColor=vec4(max(c,0.),1.);
}`;

// ---------------------------------------------------------------------------
// Foil sheen: a slow iridescent band that sweeps across the sphere now and
// then, like light over a collectible card; brighter when an answer is verified.
export const SHEEN_FRAG = /* glsl */ `
uniform float uTime,uR,uShine,uFlick;
varying vec2 vP;
${PALETTE}
void main(){
  float r=length(vP)/uR;
  if(r>1.05)discard;
  float disk=1.-smoothstep(.9,1.03,r);
  float s=dot(vP/uR,normalize(vec2(1.,.62)));
  float c=mod(uTime*.32,5.)-2.2;
  float band=exp(-pow((s-c)/.16,2.))+exp(-pow((s-c+.28)/.05,2.))*.5;
  vec3 irid=.5+.5*cos(6.28318*(vec3(0.,.33,.67)+s*.55+uTime*.03));
  vec3 col=mix(LAV,irid,.45)*band*disk*(.35+.65*pow(r,2.));
  gl_FragColor=vec4(col*uShine*uFlick,1.);
}`;
