Shader "T/Inc" {
  SubShader { Pass {
    HLSLPROGRAM
    #include "Common.hlsl"
    #include "Inner/Lighting.hlsl"
    #include "CustomCG/MyHelper.hlsl"
    #include "Packages/com.example.urp/ShaderLibrary/Core.hlsl"
    float4 main() { return Common() + Core(); }
    ENDHLSL
  } }
}
