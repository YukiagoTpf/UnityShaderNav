 Shader "Authoring/ColorFormat"
{
Properties
{
 _Color ("Color", Color) = (0.25, 0.5, 1, 0.75)
 [HDR] _Hdr ("HDR", Color) = (0.25, 0.5, 1, 1)
 _Vector ("Vector", Vector) = (0.25, 0.5, 1, 1)
}
SubShader
{
Pass
{
   HLSLPROGRAM
	float4 frag() : SV_Target {  return 1; }
 ENDHLSL
}
}
}
