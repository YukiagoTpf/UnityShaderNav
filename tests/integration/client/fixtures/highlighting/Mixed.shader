Shader "Custom/Mixed" {
  Properties {
    [Header(Main)] [Space]
    _BaseMap ("Base Map", 2D) = "white" {}
    _LayerMap ("Layers", 2DArray) = "" {}
    _ProbeMap ("Probes", CubeArray) = "" {}
    _Tint ("Tint", Color) = (1, 0.5, 0, 1)
    _Roughness ("Roughness", Range(0, 1)) = 0.5
  }
  SubShader {
    Tags { "LightMode"="UniversalForward" "RenderType"="Opaque" }
    LOD 100
    UsePass "Hidden/SHADOWCASTER"
    Pass {
      Name "Forward"
      Cull Back
      ZWrite On
      HLSLPROGRAM
      #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
      #pragma vertex vert
      #define SAMPLE_ALBEDO(tex, uv) tex.Sample(sampler##tex, uv)
      TEXTURE2D(_BaseMap);
      TEXTURE2D_HALF(_HalfMap);
      SAMPLER(sampler_BaseMap);
      Texture2D _DetailMap;
      SamplerState sampler_DetailMap;
      groupshared float SharedValue;
      CBUFFER_START(UnityPerMaterial)
      float4 _Tint;
      CBUFFER_END
      struct Attributes { float3 positionOS : POSITION; float2 uv : TEXCOORD0; };
      bool finiteScreen() { return isnan(_ScreenParams.x) || isfinite(_ScreenParams.y); }
      float4 vert(Attributes input) : SV_POSITION {
        return TransformObjectToHClip(input.positionOS).xyxy;
      }
      ENDHLSL
    }
  }
}
