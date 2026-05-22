Shader "T/Inc" {
  SubShader { Pass {
    HLSLPROGRAM
    #include "Common.hlsl"
    #include "Inner/Lighting.hlsl"
    #include "CustomCG/MyHelper.hlsl"
    ENDHLSL
  } }
}
