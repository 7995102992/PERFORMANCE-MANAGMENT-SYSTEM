package com.sentrifugo.db.mapper;

import com.sentrifugo.db.dto.PmsKpiMasterDTO;
import com.sentrifugo.db.entity.PmsKpiMasterEntity;
import org.mapstruct.Builder;
import org.mapstruct.Mapper;
import org.mapstruct.Mapping;
import org.mapstruct.MappingTarget;
import org.mapstruct.NullValuePropertyMappingStrategy;
import org.mapstruct.ReportingPolicy;

import java.util.List;

@Mapper(
        componentModel = "spring",
        unmappedTargetPolicy = ReportingPolicy.IGNORE,
        nullValuePropertyMappingStrategy = NullValuePropertyMappingStrategy.IGNORE,
        // Lombok @SuperBuilder entities/DTOs: map through constructor + setters (see PmsCycleMapper).
        builder = @Builder(disableBuilder = true)
)
public interface PmsKpiMasterMapper {

    // Parent / referenced entities are resolved and attached by the service, never taken from the DTO.
    @Mapping(target = "kra", ignore = true)
    PmsKpiMasterEntity toEntity(PmsKpiMasterDTO dto);

    @Mapping(source = "kra.id", target = "kraId")
    PmsKpiMasterDTO toDTO(PmsKpiMasterEntity entity);

    List<PmsKpiMasterEntity> toEntityList(List<PmsKpiMasterDTO> dtoList);

    List<PmsKpiMasterDTO> toDTOList(List<PmsKpiMasterEntity> entityList);

    @Mapping(target = "id", ignore = true)
    @Mapping(target = "kra", ignore = true)
    void updateEntityFromDto(PmsKpiMasterDTO dto, @MappingTarget PmsKpiMasterEntity entity);
}
