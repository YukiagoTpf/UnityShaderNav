Shader "Custom/Mixed" {
  Properties {
    [Header(Main)] [Space]
    _BaseMap ("Base Map", 2D) = "white" {}
    _Tint ("Tint", Color) = (1, 0.5, 0, 1)
    _Roughness ("Roughness", Range(0, 1)) = 0.5
  }
  SubShader {
    Tags { "LightMode"="UniversalForward" "RenderType"="Opaque" }
    LOD 100
    Pass {
      Name "Forward"
      Cull Back
      ZWrite On
      HLSLPROGRAM
      #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
      #pragma vertex vert
      #define SAMPLE_ALBEDO(tex, uv) tex.Sample(sampler##tex, uv)
      TEXTURE2D(_BaseMap);
      SAMPLER(sampler_BaseMap);
      Texture2D _DetailMap;
      SamplerState sampler_DetailMap;
      CBUFFER_START(UnityPerMaterial)
      float4 _Tint;
      CBUFFER_END
      struct Attributes { float3 positionOS : POSITION; float2 uv : TEXCOORD0; };
      float4 vert(Attributes input) : SV_POSITION {
        return TransformObjectToHClip(input.positionOS).xyxy;
      }
      ENDHLSL
    }
  }
}
