Shader "B/Main" {
  SubShader { Pass {
    HLSLPROGRAM
    #include "OnlyInB.hlsl"
    float4 main() { return OnlyInB(); }
    float4 probe() { return Common(); }
    ENDHLSL
  } }
}
