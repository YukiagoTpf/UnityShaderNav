Shader "Tests/CompileContractSelfCheck"
{
    Properties
    {
        _Tint ("Tint", Color) = (1, 1, 1, 1)
    }

    SubShader
    {
        Tags { "RenderPipeline" = "UniversalPipeline" }

        Pass
        {
            Name "Forward"

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag

            CBUFFER_START(UnityPerMaterial)
                float4 _Tint;
            CBUFFER_END

            float4 vert() : SV_POSITION { return 0; }
            float4 frag() : SV_Target { return _Tint; }
            ENDHLSL
        }
    }
}
