<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('activity_logs', function (Blueprint $table) {
            $table->id();
            $table->unsignedBigInteger('user_id')->nullable();
            $table->unsignedBigInteger('modpack_id')->nullable();
            $table->unsignedBigInteger('build_id')->nullable();
            $table->string('action', 64);
            $table->text('description');
            $table->json('properties')->nullable();
            $table->timestamp('created_at')->nullable();

            $table->index(['modpack_id', 'created_at']);
            $table->index(['build_id', 'created_at']);
            $table->index('created_at');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('activity_logs');
    }
};
