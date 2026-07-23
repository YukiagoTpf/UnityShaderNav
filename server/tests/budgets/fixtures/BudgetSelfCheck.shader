Shader "Tests/BudgetSelfCheck"
{
    SubShader
    {
        Pass
        {
            Name "Forward"
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile_fragment _ QUALITY_LOW QUALITY_HIGH
            #pragma shader_feature_local_fragment _NORMALMAP

            float4 vert() : SV_Position { return 0; }
            float4 frag() : SV_Target { return 0; }
            ENDHLSL
        }
    }
}
